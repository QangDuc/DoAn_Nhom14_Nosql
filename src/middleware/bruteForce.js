const redis = require('../config/redis');
const { revokeAccountSessions } = require('./authMiddleware');
const { publishEvent } = require('../services/events');

const FAIL_WINDOW = Number(process.env.LOGIN_FAIL_WINDOW_SECONDS) || 900; // 15 phút
const LOCK_DURATION = Number(process.env.LOGIN_LOCK_SECONDS) || 300;      // 5 phút
const MAX_ATTEMPTS = Number(process.env.LOGIN_MAX_ATTEMPTS) || 5;

const IP_FAIL_WINDOW = Number(process.env.IP_FAIL_WINDOW_SECONDS) || 900;  // 15 phút
const IP_BLOCK_DURATION = Number(process.env.IP_BLOCK_SECONDS) || 600;     // 10 phút
const IP_MAX_FAILS = Number(process.env.IP_MAX_FAILS) || 20;               // 20 lần sai
const IP_MAX_ACCOUNTS = Number(process.env.IP_MAX_ACCOUNTS) || 5;          // 5 tài khoản khác nhau

/**
 * Lấy IP thực của client dựa theo cấu hình TRUST_PROXY và DEMO_MODE
 */
function getClientIp(req) {
  if (process.env.DEMO_MODE === 'true' && req.headers['x-demo-ip']) {
    return String(req.headers['x-demo-ip']).trim();
  }
  if (process.env.TRUST_PROXY === 'true' && req.headers['x-forwarded-for']) {
    const forwarded = String(req.headers['x-forwarded-for']).split(',')[0].trim();
    if (forwarded) return forwarded;
  }
  return req.ip || (req.socket && req.socket.remoteAddress) || '127.0.0.1';
}

/**
 * Chuẩn hóa IPv6: Thay thế ':' bằng '_' trong tên key Redis
 */
function sanitizeIp(ip) {
  return String(ip).replace(/:/g, '_');
}

/**
 * Middleware chống tấn công Brute-force cho endpoint /api/auth/login
 * 1. Kiểm tra chặn theo IP (login:ipblock:{ip}) trước.
 * 2. Kiểm tra khóa theo tài khoản (login:lock:{accountId}) sau.
 */
async function checkBruteForceLock(req, res, next) {
  try {
    const rawIp = getClientIp(req);
    const sanitizedIp = sanitizeIp(rawIp);
    const ipBlockKey = `login:ipblock:${sanitizedIp}`;
    const ipBlockVal = await redis.get(ipBlockKey);

    if (ipBlockVal !== null) {
      const ttlSeconds = await redis.ttl(ipBlockKey);
      return res.status(429).json({
        error: `Địa chỉ IP (${rawIp}) đang bị tạm chặn do nghi vấn tấn công Dictionary Attack (Brute-Force).`,
        scope: 'ip',
        remainingSeconds: ttlSeconds > 0 ? ttlSeconds : 0,
        blocked: true
      });
    }

    const { accountId } = req.body;
    if (!accountId) {
      return res.status(400).json({ error: 'Vui lòng cung cấp accountId' });
    }

    const lockKey = `login:lock:${accountId}`;
    const lockValue = await redis.get(lockKey);

    if (lockValue !== null) {
      // Khi tài khoản đã bị khóa nhưng IP vẫn tiếp tục gửi yêu cầu đăng nhập,
      // ghi nhận tiếp số lần thất bại cho IP (chống spam/brute-force vào tài khoản đã khóa)
      const ipFailKey = `login:ip:${sanitizedIp}`;
      const ipAccountsKey = `login:ip:${sanitizedIp}:accounts`;
      const ipBlockKey = `login:ipblock:${sanitizedIp}`;

      const ipFails = await redis.incr(ipFailKey);
      if (ipFails === 1) {
        await redis.expire(ipFailKey, IP_FAIL_WINDOW);
      } else {
        const currentIpTtl = await redis.ttl(ipFailKey);
        if (currentIpTtl === -1) {
          await redis.expire(ipFailKey, IP_FAIL_WINDOW);
        }
      }

      await redis.sadd(ipAccountsKey, accountId);
      const accTtl = await redis.ttl(ipAccountsKey);
      if (accTtl === -1 || accTtl === -2) {
        await redis.expire(ipAccountsKey, IP_FAIL_WINDOW);
      }

      const distinctAccountsCount = await redis.scard(ipAccountsKey);

      if (ipFails >= IP_MAX_FAILS || distinctAccountsCount >= IP_MAX_ACCOUNTS) {
        await redis.set(ipBlockKey, 'blocked', 'EX', IP_BLOCK_DURATION);
        await publishEvent('IP_BLOCKED', {
          accountId,
          ip: rawIp,
          detail: `Chặn IP do đạt ngưỡng sai ${ipFails} lần`
        });
        return res.status(429).json({
          error: `Địa chỉ IP (${rawIp}) đã bị tạm chặn do nghi vấn tấn công Dictionary Attack (Brute-Force)!`,
          scope: 'ip',
          remainingSeconds: IP_BLOCK_DURATION,
          blocked: true
        });
      }

      const ttlSeconds = await redis.ttl(lockKey);
      return res.status(429).json({
        error: `Tài khoản ${accountId} đang bị tạm khóa do nhập sai mật khẩu quá 5 lần.`,
        locked: true,
        remainingSeconds: ttlSeconds > 0 ? ttlSeconds : 0
      });
    }

    req.clientIp = rawIp;
    req.sanitizedIp = sanitizedIp;
    next();
  } catch (err) {
    console.error('[BruteForce Middleware] Lỗi kiểm tra Redis:', err.message);
    return res.status(500).json({ error: 'Lỗi hệ thống khi kiểm tra bảo mật Redis' });
  }
}

/**
 * Ghi nhận một lần đăng nhập thất bại vào Redis:
 * - Theo tài khoản: INCR login:fail:{id} (đạt 5 lần khóa account và tự động xóa toàn bộ phiên)
 * - Theo IP: INCR login:ip:{ip} và SADD login:ip:{ip}:accounts {id}
 * - Chặn IP bằng login:ipblock:{ip} khi sai >= 20 lần HOẶC thử >= 5 tài khoản khác nhau
 */
async function recordLoginFailure(accountId, reqOrIp) {
  let rawIp = '127.0.0.1';
  if (typeof reqOrIp === 'string') {
    rawIp = reqOrIp;
  } else if (reqOrIp && reqOrIp.headers) {
    rawIp = getClientIp(reqOrIp);
  }
  const sanitizedIp = sanitizeIp(rawIp);

  // 1. Xử lý bộ đếm theo Tài khoản
  const failKey = `login:fail:${accountId}`;
  const lockKey = `login:lock:${accountId}`;

  const attempts = await redis.incr(failKey);

  if (attempts === 1) {
    await redis.expire(failKey, FAIL_WINDOW);
  } else {
    const currentTtl = await redis.ttl(failKey);
    if (currentTtl === -1) {
      await redis.expire(failKey, FAIL_WINDOW);
    }
  }

  let accountLocked = false;
  let remainingAttempts = MAX_ATTEMPTS - attempts;
  let lockRemainingSeconds = 0;

  if (attempts >= MAX_ATTEMPTS) {
    accountLocked = true;
    remainingAttempts = 0;
    lockRemainingSeconds = LOCK_DURATION;
    const freezeSeconds = Number(process.env.FREEZE_SECONDS) || 900;
    await redis.set(lockKey, 'locked', 'EX', LOCK_DURATION);
    await redis.set(`account:frozen:${accountId}`, 'BRUTE_FORCE', 'EX', freezeSeconds);
    await redis.del(failKey);

    await publishEvent('ACCOUNT_LOCKED', {
      accountId,
      ip: rawIp,
      detail: `Khóa tài khoản 5 phút do nhập sai ${attempts} lần`
    });
    await publishEvent('ACCOUNT_FROZEN', {
      accountId,
      ip: rawIp,
      detail: 'Đóng băng tài khoản do BRUTE_FORCE'
    });

    // Tự động thu hồi/xóa tất cả phiên của tài khoản này khi bị khóa
    await revokeAccountSessions(accountId);
  }

  // 2. Xử lý bộ đếm theo Địa chỉ IP (IP Defense)
  const ipFailKey = `login:ip:${sanitizedIp}`;
  const ipAccountsKey = `login:ip:${sanitizedIp}:accounts`;
  const ipBlockKey = `login:ipblock:${sanitizedIp}`;

  const ipFails = await redis.incr(ipFailKey);
  if (ipFails === 1) {
    await redis.expire(ipFailKey, IP_FAIL_WINDOW);
  } else {
    const currentIpTtl = await redis.ttl(ipFailKey);
    if (currentIpTtl === -1) {
      await redis.expire(ipFailKey, IP_FAIL_WINDOW);
    }
  }

  await redis.sadd(ipAccountsKey, accountId);
  const accTtl = await redis.ttl(ipAccountsKey);
  if (accTtl === -1 || accTtl === -2) {
    await redis.expire(ipAccountsKey, IP_FAIL_WINDOW);
  }

  const distinctAccountsCount = await redis.scard(ipAccountsKey);

  let ipBlocked = false;
  let ipBlockRemainingSeconds = 0;

  if (ipFails >= IP_MAX_FAILS || distinctAccountsCount >= IP_MAX_ACCOUNTS) {
    ipBlocked = true;
    ipBlockRemainingSeconds = IP_BLOCK_DURATION;
    await redis.set(ipBlockKey, 'blocked', 'EX', IP_BLOCK_DURATION);
    await publishEvent('IP_BLOCKED', {
      accountId,
      ip: rawIp,
      detail: `Chặn IP 10 phút (sai ${ipFails} lần / ${distinctAccountsCount} tài khoản)`
    });
  }

  const failTtl = await redis.ttl(failKey);

  return {
    locked: accountLocked,
    attempts,
    remainingAttempts: Math.max(0, remainingAttempts),
    remainingSeconds: lockRemainingSeconds,
    failWindowRemainingSeconds: failTtl > 0 ? failTtl : FAIL_WINDOW,
    // Thông tin IP Defense
    rawIp,
    sanitizedIp,
    ipBlocked,
    ipFails,
    distinctAccountsCount,
    ipBlockRemainingSeconds
  };
}

/**
 * Middleware chống brute-force cho đăng nhập nhân viên /api/staff/login
 * Sử dụng key riêng login:lock:staff:{id}
 */
async function checkStaffBruteForceLock(req, res, next) {
  try {
    const rawIp = getClientIp(req);
    const sanitizedIp = sanitizeIp(rawIp);
    const ipBlockKey = `login:ipblock:${sanitizedIp}`;
    const ipBlockVal = await redis.get(ipBlockKey);

    if (ipBlockVal !== null) {
      const ttlSeconds = await redis.ttl(ipBlockKey);
      return res.status(429).json({
        error: `Địa chỉ IP (${rawIp}) đang bị tạm chặn do nghi vấn tấn công Dictionary Attack (Brute-Force).`,
        scope: 'ip',
        remainingSeconds: ttlSeconds > 0 ? ttlSeconds : 0,
        blocked: true
      });
    }

    const { staffId } = req.body;
    if (!staffId) {
      return res.status(400).json({ error: 'Vui lòng cung cấp staffId' });
    }

    const lockKey = `login:lock:staff:${staffId}`;
    const lockValue = await redis.get(lockKey);

    if (lockValue !== null) {
      const ipFailKey = `login:ip:${sanitizedIp}`;
      const ipAccountsKey = `login:ip:${sanitizedIp}:accounts`;

      const ipFails = await redis.incr(ipFailKey);
      if (ipFails === 1) {
        await redis.expire(ipFailKey, IP_FAIL_WINDOW);
      }

      await redis.sadd(ipAccountsKey, `staff:${staffId}`);
      const accTtl = await redis.ttl(ipAccountsKey);
      if (accTtl === -1 || accTtl === -2) {
        await redis.expire(ipAccountsKey, IP_FAIL_WINDOW);
      }

      const distinctAccountsCount = await redis.scard(ipAccountsKey);
      if (ipFails >= IP_MAX_FAILS || distinctAccountsCount >= IP_MAX_ACCOUNTS) {
        await redis.set(ipBlockKey, 'blocked', 'EX', IP_BLOCK_DURATION);
        await publishEvent('IP_BLOCKED', {
          accountId: staffId,
          ip: rawIp,
          detail: `Chặn IP do đạt ngưỡng sai ${ipFails} lần khi đăng nhập nhân viên`
        });
        return res.status(429).json({
          error: `Địa chỉ IP (${rawIp}) đã bị tạm chặn do nghi vấn tấn công Dictionary Attack (Brute-Force)!`,
          scope: 'ip',
          remainingSeconds: IP_BLOCK_DURATION,
          blocked: true
        });
      }

      const ttlSeconds = await redis.ttl(lockKey);
      return res.status(429).json({
        error: `Tài khoản nhân viên ${staffId} đang bị tạm khóa do nhập sai mật khẩu quá 5 lần.`,
        locked: true,
        remainingSeconds: ttlSeconds > 0 ? ttlSeconds : 0
      });
    }

    req.clientIp = rawIp;
    req.sanitizedIp = sanitizedIp;
    next();
  } catch (err) {
    console.error('[Staff BruteForce] Lỗi kiểm tra Redis:', err.message);
    return res.status(500).json({ error: 'Lỗi hệ thống khi kiểm tra bảo mật Redis' });
  }
}

/**
 * Ghi nhận một lần đăng nhập sai của nhân viên:
 * - Dùng tiền tố key riêng: login:fail:staff:{id} và login:lock:staff:{id}
 */
async function recordStaffLoginFailure(staffId, reqOrIp) {
  let rawIp = '127.0.0.1';
  if (typeof reqOrIp === 'string') {
    rawIp = reqOrIp;
  } else if (reqOrIp && reqOrIp.headers) {
    rawIp = getClientIp(reqOrIp);
  }
  const sanitizedIp = sanitizeIp(rawIp);

  const failKey = `login:fail:staff:${staffId}`;
  const lockKey = `login:lock:staff:${staffId}`;

  const attempts = await redis.incr(failKey);
  if (attempts === 1) {
    await redis.expire(failKey, FAIL_WINDOW);
  } else {
    const currentTtl = await redis.ttl(failKey);
    if (currentTtl === -1) {
      await redis.expire(failKey, FAIL_WINDOW);
    }
  }

  let locked = false;
  let remainingAttempts = MAX_ATTEMPTS - attempts;
  let lockRemainingSeconds = 0;

  if (attempts >= MAX_ATTEMPTS) {
    locked = true;
    remainingAttempts = 0;
    lockRemainingSeconds = LOCK_DURATION;
    await redis.set(lockKey, 'locked', 'EX', LOCK_DURATION);
    await redis.del(failKey);

    await publishEvent('ACCOUNT_LOCKED', {
      accountId: staffId,
      ip: rawIp,
      detail: `Khóa tài khoản nhân viên 5 phút do nhập sai ${attempts} lần`
    });

    try {
      const { revokeStaffSessions } = require('./authMiddleware');
      if (typeof revokeStaffSessions === 'function') {
        await revokeStaffSessions(staffId);
      }
    } catch (_) {}
  }

  // IP Defense
  const ipFailKey = `login:ip:${sanitizedIp}`;
  const ipAccountsKey = `login:ip:${sanitizedIp}:accounts`;
  const ipBlockKey = `login:ipblock:${sanitizedIp}`;

  const ipFails = await redis.incr(ipFailKey);
  if (ipFails === 1) {
    await redis.expire(ipFailKey, IP_FAIL_WINDOW);
  } else {
    const currentIpTtl = await redis.ttl(ipFailKey);
    if (currentIpTtl === -1) {
      await redis.expire(ipFailKey, IP_FAIL_WINDOW);
    }
  }

  await redis.sadd(ipAccountsKey, `staff:${staffId}`);
  const accTtl = await redis.ttl(ipAccountsKey);
  if (accTtl === -1 || accTtl === -2) {
    await redis.expire(ipAccountsKey, IP_FAIL_WINDOW);
  }

  const distinctAccountsCount = await redis.scard(ipAccountsKey);
  let ipBlocked = false;
  let ipBlockRemainingSeconds = 0;

  if (ipFails >= IP_MAX_FAILS || distinctAccountsCount >= IP_MAX_ACCOUNTS) {
    ipBlocked = true;
    ipBlockRemainingSeconds = IP_BLOCK_DURATION;
    await redis.set(ipBlockKey, 'blocked', 'EX', IP_BLOCK_DURATION);
    await publishEvent('IP_BLOCKED', {
      accountId: staffId,
      ip: rawIp,
      detail: `Chặn IP 10 phút (sai ${ipFails} lần khi đăng nhập nhân viên)`
    });
  }

  const failTtl = await redis.ttl(failKey);

  return {
    locked,
    attempts,
    remainingAttempts: Math.max(0, remainingAttempts),
    remainingSeconds: lockRemainingSeconds,
    failWindowRemainingSeconds: failTtl > 0 ? failTtl : FAIL_WINDOW,
    rawIp,
    sanitizedIp,
    ipBlocked,
    ipFails,
    distinctAccountsCount,
    ipBlockRemainingSeconds
  };
}

module.exports = {
  checkBruteForceLock,
  recordLoginFailure,
  checkStaffBruteForceLock,
  recordStaffLoginFailure,
  getClientIp,
  sanitizeIp
};
