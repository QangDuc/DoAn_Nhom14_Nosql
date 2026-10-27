const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { driver } = require('../config/neo4j');
const redis = require('../config/redis');
const { checkBruteForceLock, recordLoginFailure, getClientIp, sanitizeIp } = require('../middleware/bruteForce');
const { requireSession, requireRole, revokeAccountSessions, revokeSessionById } = require('../middleware/authMiddleware');
const { publishEvent } = require('../services/events');
const { logAudit } = require('../services/audit');

const router = express.Router();

const SESSION_TTL = Number(process.env.SESSION_TTL_SECONDS) || 3600;      // 1 giờ
const MAX_ATTEMPTS = Number(process.env.LOGIN_MAX_ATTEMPTS) || 5;

/**
 * Quét toàn bộ key theo pattern bằng lệnh SCAN thay vì KEYS
 */
async function scanKeys(pattern) {
  let cursor = '0';
  const foundKeys = [];
  do {
    const reply = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
    cursor = reply[0];
    const keys = reply[1];
    if (keys && keys.length > 0) {
      foundKeys.push(...keys);
    }
  } while (cursor !== '0');
  return foundKeys;
}

/**
 * POST /api/auth/login
 * Đăng nhập tài khoản có bảo vệ chống Brute-force bằng Redis
 */
router.post('/login', checkBruteForceLock, async (req, res) => {
  const { accountId, password } = req.body;
  if (!accountId || !password) {
    return res.status(400).json({ error: 'Vui lòng nhập đầy đủ accountId và password' });
  }

  const session = driver.session();
  try {
    // 1. Tìm tài khoản trong Neo4j
    const result = await session.run(
      `MATCH (a:Account {accountId: $accountId}) RETURN a`,
      { accountId }
    );

    // Điểm 3: Tài khoản không tồn tại phải trả cùng phản hồi 401 như sai mật khẩu và cũng bị đếm INCR (chống dò tài khoản)
    if (result.records.length === 0) {
      const failResult = await recordLoginFailure(accountId, req);
      await publishEvent('LOGIN_FAIL', {
        accountId,
        ip: getClientIp(req),
        detail: `Đăng nhập thất bại: Tài khoản không tồn tại (lần ${failResult.attempts})`
      });
      if (failResult.ipBlocked) {
        return res.status(429).json({
          error: `Địa chỉ IP (${failResult.rawIp}) đã bị tạm chặn do nghi vấn tấn công Dictionary Attack (Brute-Force)!`,
          scope: 'ip',
          remainingSeconds: failResult.ipBlockRemainingSeconds,
          blocked: true
        });
      }
      if (failResult.locked) {
        return res.status(429).json({
          error: `Sai mật khẩu lần thứ ${failResult.attempts}. Tài khoản ${accountId} đã bị KHÓA 5 phút (300 giây)!`,
          locked: true,
          attempts: failResult.attempts,
          remainingAttempts: 0,
          remainingSeconds: failResult.remainingSeconds
        });
      }
      return res.status(401).json({
        error: `Sai mật khẩu! Bạn đã nhập sai ${failResult.attempts}/${MAX_ATTEMPTS} lần. Còn ${failResult.remainingAttempts} lần thử trước khi bị khóa.`,
        locked: false,
        attempts: failResult.attempts,
        remainingAttempts: failResult.remainingAttempts,
        failWindowRemainingSeconds: failResult.failWindowRemainingSeconds
      });
    }

    const account = result.records[0].get('a').properties;

    if (account.status === 'CLOSED') {
      return res.status(403).json({ error: `Tài khoản ${accountId} đã bị đóng` });
    }

    // 2. Kiểm tra mật khẩu bằng bcrypt
    const isMatch = await bcrypt.compare(password, account.passwordHash);

    if (!isMatch) {
      const failResult = await recordLoginFailure(accountId, req);
      await publishEvent('LOGIN_FAIL', {
        accountId,
        ip: getClientIp(req),
        detail: `Đăng nhập thất bại: Sai mật khẩu (lần ${failResult.attempts}/5)`
      });
      if (failResult.ipBlocked) {
        return res.status(429).json({
          error: `Địa chỉ IP (${failResult.rawIp}) đã bị tạm chặn do nghi vấn tấn công Dictionary Attack (Brute-Force)!`,
          scope: 'ip',
          remainingSeconds: failResult.ipBlockRemainingSeconds,
          blocked: true
        });
      }
      if (failResult.locked) {
        return res.status(429).json({
          error: `Sai mật khẩu lần thứ ${failResult.attempts}. Tài khoản ${accountId} đã bị KHÓA 5 phút (300 giây)!`,
          locked: true,
          attempts: failResult.attempts,
          remainingAttempts: 0,
          remainingSeconds: failResult.remainingSeconds
        });
      }
      return res.status(401).json({
        error: `Sai mật khẩu! Bạn đã nhập sai ${failResult.attempts}/${MAX_ATTEMPTS} lần. Còn ${failResult.remainingAttempts} lần thử trước khi bị khóa.`,
        locked: false,
        attempts: failResult.attempts,
        remainingAttempts: failResult.remainingAttempts,
        failWindowRemainingSeconds: failResult.failWindowRemainingSeconds
      });
    }

    // 3. Đăng nhập đúng: Xóa bộ đếm lỗi bằng DEL login:fail:{accountId}
    await redis.del(`login:fail:${accountId}`);

    // Tạo phiên đăng nhập lưu vào Redis dạng JSON: session:{token} -> { accountId, role, createdAt }
    const token = crypto.randomBytes(24).toString('hex');
    const sessionKey = `session:${token}`;
    const clientIp = getClientIp(req);
    const userRole = account.role || 'CUSTOMER';
    const sessionData = {
      accountId,
      role: userRole,
      createdAt: Date.now(),
      ip: clientIp,
      subjectId: accountId,
      subjectType: userRole
    };
    await redis.set(sessionKey, JSON.stringify(sessionData), 'EX', SESSION_TTL);

    // Lưu cookie httpOnly và SameSite=Strict
    res.cookie('token', token, {
      httpOnly: true,
      sameSite: 'strict',
      maxAge: SESSION_TTL * 1000
    });

    await publishEvent('LOGIN_OK', {
      accountId,
      ip: clientIp,
      detail: `Đăng nhập thành công (${account.ownerName})`
    });

    return res.json({
      message: `Đăng nhập thành công vào tài khoản ${accountId} (${account.ownerName})`,
      token,
      role: userRole,
      sessionTtlSeconds: SESSION_TTL,
      account: {
        accountId: account.accountId,
        ownerName: account.ownerName,
        balance: account.balance,
        status: account.status,
        role: userRole
      }
    });
  } catch (err) {
    console.error('[Auth Login] Lỗi:', err.message);
    return res.status(500).json({ error: 'Lỗi máy chủ khi xử lý đăng nhập' });
  } finally {
    await session.close();
  }
});

/**
 * GET /api/auth/me
 * Xem thông tin tài khoản hiện tại từ phiên đăng nhập
 */
router.get('/me', requireSession, async (req, res) => {
  const accountId = req.sessionAccountId;
  const session = driver.session();
  try {
    const result = await session.run(
      `MATCH (a:Account {accountId: $accountId}) RETURN a`,
      { accountId }
    );

    if (result.records.length === 0) {
      return res.status(404).json({ error: `Không tìm thấy tài khoản ${accountId}` });
    }

    const account = result.records[0].get('a').properties;
    return res.json({
      accountId: account.accountId,
      ownerName: account.ownerName,
      balance: account.balance,
      status: account.status,
      createdAt: account.createdAt,
      session: req.sessionMeta || null
    });
  } catch (err) {
    console.error('[Auth Me] Lỗi:', err.message);
    return res.status(500).json({ error: 'Lỗi khi lấy thông tin phiên đăng nhập' });
  } finally {
    await session.close();
  }
});

/**
 * POST /api/auth/logout
 * Đăng xuất và xóa phiên session:{token} trong Redis
 */
router.post('/logout', requireSession, async (req, res) => {
  try {
    const sessionKey = `session:${req.sessionToken}`;
    await redis.del(sessionKey);
    return res.json({
      message: 'Đăng xuất thành công',
      accountId: req.sessionAccountId
    });
  } catch (err) {
    console.error('[Auth Logout] Lỗi:', err.message);
    return res.status(500).json({ error: 'Lỗi khi đăng xuất' });
  }
});

/**
 * GET /api/auth/admin/security-status
 * Endpoint: Xem danh sách các tài khoản đang có bộ đếm sai hoặc đang bị khóa kèm TTL
 */
router.get('/admin/security-status', requireRole('ADMIN'), async (req, res) => {
  try {
    // Quét các key login:fail:* và login:lock:* bằng SCAN
    const failKeys = await scanKeys('login:fail:*');
    const lockKeys = await scanKeys('login:lock:*');

    const accountMap = new Map();

    // Dùng MGET lấy giá trị của tất cả login:fail:* trong 1 lệnh duy nhất
    let failCounts = [];
    if (failKeys.length > 0) {
      failCounts = await redis.mget(...failKeys);
    }

    // Gom lấy TTL của tất cả failKeys và lockKeys bằng pipeline
    const pipe = redis.pipeline();
    for (const key of failKeys) {
      pipe.ttl(key);
    }
    for (const key of lockKeys) {
      pipe.ttl(key);
    }

    let ttlResults = [];
    if (failKeys.length > 0 || lockKeys.length > 0) {
      ttlResults = await pipe.exec();
    }

    // Trích xuất dữ liệu failKeys
    for (let i = 0; i < failKeys.length; i++) {
      const key = failKeys[i];
      const accountId = key.replace('login:fail:', '');
      const count = failCounts[i];
      const ttl = ttlResults[i] ? ttlResults[i][1] : 0;
      accountMap.set(accountId, {
        accountId,
        failCount: Number(count) || 0,
        failTtl: ttl > 0 ? ttl : 0,
        isLocked: false,
        lockTtl: 0
      });
    }

    // Trích xuất dữ liệu lockKeys
    for (let j = 0; j < lockKeys.length; j++) {
      const key = lockKeys[j];
      const accountId = key.replace('login:lock:', '');
      const ttl = ttlResults[failKeys.length + j] ? ttlResults[failKeys.length + j][1] : 0;
      const existing = accountMap.get(accountId) || {
        accountId,
        failCount: MAX_ATTEMPTS,
        failTtl: 0
      };
      existing.isLocked = true;
      existing.lockTtl = ttl > 0 ? ttl : 0;
      accountMap.set(accountId, existing);
    }

    // Gán trường status: "LOCKED" nếu có key login:lock, "WARNING" nếu failCount >= 3, ngược lại "NORMAL"
    for (const item of accountMap.values()) {
      if (item.isLocked) {
        item.status = 'LOCKED';
      } else if (item.failCount >= 3) {
        item.status = 'WARNING';
      } else {
        item.status = 'NORMAL';
      }
    }

    // Sắp xếp tài khoản đang bị khóa lên đầu, sau đó theo số lần sai giảm dần
    const items = Array.from(accountMap.values()).sort((a, b) => {
      if (a.isLocked !== b.isLocked) return a.isLocked ? -1 : 1;
      return b.failCount - a.failCount;
    });

    const lockedCount = items.filter(i => i.status === 'LOCKED').length;
    const warningCount = items.filter(i => i.status === 'WARNING').length;

    return res.json({
      timestamp: new Date().toISOString(),
      totalMonitored: items.length,
      summary: {
        monitored: items.length,
        locked: lockedCount,
        warning: warningCount
      },
      items
    });
  } catch (err) {
    console.error('[Security Status] Lỗi:', err.message);
    return res.status(500).json({ error: 'Không thể lấy trạng thái bảo mật từ Redis' });
  }
});

/**
 * POST /api/auth/admin/unlock/:accountId
 * Endpoint Admin: Mở khóa thủ công và xóa bộ đếm sai cho một tài khoản (Chỉ ADMIN)
 */
router.post('/admin/unlock/:accountId', requireRole('ADMIN'), async (req, res) => {
  try {
    const { accountId } = req.params;
    const failKey = `login:fail:${accountId}`;
    const lockKey = `login:lock:${accountId}`;

    // Xóa cả key lock và key fail
    await redis.del(lockKey, failKey);

    await logAudit({
      actor: req.sessionUser?.subjectId || 'UNKNOWN',
      role: req.sessionUser?.role || 'ADMIN',
      action: 'UNLOCK_ACCOUNT',
      target: accountId,
      ip: req.sessionUser?.ip || req.ip || '127.0.0.1'
    });

    return res.json({
      message: `Đã mở khóa và đặt lại bộ đếm sai cho tài khoản ${accountId} thành công.`,
      accountId
    });
  } catch (err) {
    console.error('[Admin Unlock] Lỗi:', err.message);
    return res.status(500).json({ error: 'Lỗi khi mở khóa tài khoản' });
  }
});

/**
 * GET /api/auth/admin/ip-status
 * Endpoint Admin: Danh sách các IP đang có bộ đếm hoặc bị chặn kèm số tài khoản đã thử và TTL
 */
router.get('/admin/ip-status', requireRole('ADMIN', 'ANALYST'), async (req, res) => {
  try {
    const ipKeys = await scanKeys('login:ip:*');
    const blockKeys = await scanKeys('login:ipblock:*');

    const sanitizedIps = new Set();
    for (const key of ipKeys) {
      if (key.endsWith(':accounts')) {
        sanitizedIps.add(key.slice('login:ip:'.length, -':accounts'.length));
      } else {
        sanitizedIps.add(key.slice('login:ip:'.length));
      }
    }
    for (const key of blockKeys) {
      sanitizedIps.add(key.slice('login:ipblock:'.length));
    }

    const items = [];
    for (const sIp of sanitizedIps) {
      if (!sIp) continue;
      const ipFailKey = `login:ip:${sIp}`;
      const ipAccountsKey = `login:ip:${sIp}:accounts`;
      const ipBlockKey = `login:ipblock:${sIp}`;

      const failCount = Number(await redis.get(ipFailKey)) || 0;
      const accountsCount = (await redis.scard(ipAccountsKey)) || 0;
      const isBlocked = (await redis.get(ipBlockKey)) !== null;
      const blockTtl = await redis.ttl(ipBlockKey);
      const failTtl = await redis.ttl(ipFailKey);

      let status = 'NORMAL';
      let ttl = 0;
      if (isBlocked) {
        status = 'BLOCKED';
        ttl = blockTtl > 0 ? blockTtl : 0;
      } else if (failCount >= 10 || accountsCount >= 3) {
        status = 'WARNING';
        ttl = failTtl > 0 ? failTtl : 0;
      } else {
        status = 'NORMAL';
        ttl = failTtl > 0 ? failTtl : 0;
      }

      items.push({
        ip: sIp,
        rawIp: sIp.replace(/_/g, ':'),
        failCount,
        accountsTried: accountsCount,
        isBlocked,
        ttl,
        status
      });
    }

    items.sort((a, b) => {
      if (a.isBlocked !== b.isBlocked) return a.isBlocked ? -1 : 1;
      return b.failCount - a.failCount;
    });

    const blockedCount = items.filter(i => i.status === 'BLOCKED').length;
    const warningCount = items.filter(i => i.status === 'WARNING').length;

    return res.json({
      timestamp: new Date().toISOString(),
      totalMonitored: items.length,
      summary: {
        monitored: items.length,
        blocked: blockedCount,
        warning: warningCount
      },
      items
    });
  } catch (err) {
    console.error('[Admin IP Status] Lỗi:', err.message);
    return res.status(500).json({ error: 'Lỗi khi lấy danh sách IP từ Redis' });
  }
});

/**
 * POST /api/auth/admin/ip-unblock/:ip
 * Endpoint Admin: Gỡ chặn IP và xóa các key login:ipblock, login:ip, login:ip:accounts (Chỉ ADMIN)
 */
router.post('/admin/ip-unblock/:ip', requireRole('ADMIN'), async (req, res) => {
  try {
    const rawIp = req.params.ip;
    const sIp = sanitizeIp(rawIp);

    await redis.del(`login:ipblock:${sIp}`, `login:ip:${sIp}`, `login:ip:${sIp}:accounts`);

    await logAudit({
      actor: req.sessionUser?.subjectId || 'UNKNOWN',
      role: req.sessionUser?.role || 'ADMIN',
      action: 'UNBLOCK_IP',
      target: rawIp,
      ip: req.sessionUser?.ip || req.ip || '127.0.0.1'
    });

    return res.json({
      message: `Đã gỡ chặn và đặt lại bộ đếm cho IP ${rawIp} thành công.`,
      ip: rawIp,
      sanitizedIp: sIp
    });
  } catch (err) {
    console.error('[Admin IP Unblock] Lỗi:', err.message);
    return res.status(500).json({ error: 'Lỗi khi gỡ chặn IP' });
  }
});

/**
 * GET /api/auth/admin/sessions
 * Endpoint Admin: Danh sách phiên đang hoạt động (TUYỆT ĐỐI không trả full token)
 */
router.get('/admin/sessions', requireRole('ADMIN', 'ANALYST'), async (req, res) => {
  try {
    const sessionKeys = await scanKeys('session:*');
    const sessions = [];

    for (const key of sessionKeys) {
      const fullToken = key.replace('session:', '');
      const sessionId = fullToken.substring(0, 8);
      const ttl = await redis.ttl(key);
      const rawVal = await redis.get(key);

      let accountId = rawVal;
      let ip = 'Unknown';
      let userAgent = 'Unknown';
      let ageSeconds = 0;

      try {
        const parsed = JSON.parse(rawVal);
        if (parsed && parsed.accountId) {
          accountId = parsed.accountId;
          ip = parsed.ip || 'Unknown';
          userAgent = parsed.userAgent || 'Unknown';
          if (parsed.createdAt) {
            ageSeconds = Math.max(0, Math.floor((Date.now() - parsed.createdAt) / 1000));
          }
        }
      } catch (_) {}

      sessions.push({
        sessionId,
        accountId,
        ip,
        userAgent,
        ageSeconds,
        ttl: ttl > 0 ? ttl : 0
      });
    }

    sessions.sort((a, b) => a.ageSeconds - b.ageSeconds);

    return res.json({
      timestamp: new Date().toISOString(),
      totalSessions: sessions.length,
      sessions
    });
  } catch (err) {
    console.error('[Admin Sessions] Lỗi:', err.message);
    return res.status(500).json({ error: 'Lỗi khi lấy danh sách phiên từ Redis' });
  }
});

/**
 * POST /api/auth/admin/sessions/revoke
 * Endpoint Admin: Thu hồi phiên theo sessionId (8 ký tự đầu) hoặc theo accountId (Chỉ ADMIN)
 */
router.post('/admin/sessions/revoke', requireRole('ADMIN'), async (req, res) => {
  try {
    const { sessionId, accountId } = req.body;

    if (!sessionId && !accountId) {
      return res.status(400).json({ error: 'Vui lòng cung cấp sessionId hoặc accountId cần thu hồi' });
    }

    let revokedCount = 0;
    if (sessionId) {
      revokedCount = await revokeSessionById(sessionId);
      await logAudit({
        actor: req.sessionUser?.subjectId || 'UNKNOWN',
        role: req.sessionUser?.role || 'ADMIN',
        action: 'REVOKE_SESSION',
        target: sessionId,
        ip: req.sessionUser?.ip || req.ip || '127.0.0.1'
      });
      return res.json({
        message: `Đã thu hồi ${revokedCount} phiên cho session ID ${sessionId}`,
        sessionId,
        revokedCount
      });
    }

    if (accountId) {
      revokedCount = await revokeAccountSessions(accountId);
      await logAudit({
        actor: req.sessionUser?.subjectId || 'UNKNOWN',
        role: req.sessionUser?.role || 'ADMIN',
        action: 'REVOKE_ACCOUNT_SESSIONS',
        target: accountId,
        ip: req.sessionUser?.ip || req.ip || '127.0.0.1'
      });
      return res.json({
        message: `Đã thu hồi tất cả ${revokedCount} phiên của tài khoản ${accountId}`,
        accountId,
        revokedCount
      });
    }
  } catch (err) {
    console.error('[Admin Revoke Session] Lỗi:', err.message);
    return res.status(500).json({ error: 'Lỗi khi thu hồi phiên' });
  }
});

module.exports = router;
