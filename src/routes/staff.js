const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { driver } = require('../config/neo4j');
const redis = require('../config/redis');
const {
  checkStaffBruteForceLock,
  recordStaffLoginFailure,
  getClientIp
} = require('../middleware/bruteForce');
const { requireSession, requireRole } = require('../middleware/authMiddleware');
const { publishEvent } = require('../services/events');
const { getAuditLogs } = require('../services/audit');

const router = express.Router();
const SESSION_TTL = Number(process.env.SESSION_TTL_SECONDS) || 3600;
const MAX_ATTEMPTS = Number(process.env.LOGIN_MAX_ATTEMPTS) || 5;

/**
 * POST /api/staff/login
 * Đăng nhập dành cho nhân viên (ADMIN hoặc ANALYST)
 * Bảo vệ chống brute-force riêng với login:fail:staff:{id} và login:lock:staff:{id}
 */
router.post('/login', checkStaffBruteForceLock, async (req, res) => {
  const { staffId, password } = req.body;
  if (!staffId || !password) {
    return res.status(400).json({ error: 'Vui lòng cung cấp staffId và password' });
  }

  const session = driver.session();
  try {
    const result = await session.run(
      `MATCH (s:Staff {staffId: $staffId}) RETURN s`,
      { staffId }
    );

    if (result.records.length === 0) {
      const failResult = await recordStaffLoginFailure(staffId, req);
      await publishEvent('STAFF_LOGIN_FAIL', {
        accountId: staffId,
        ip: getClientIp(req),
        detail: `Đăng nhập nhân viên thất bại: Không tìm thấy staffId (lần ${failResult.attempts})`
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
          error: `Nhân viên ${staffId} đã bị khóa 5 phút do đăng nhập sai ${failResult.attempts} lần!`,
          locked: true,
          attempts: failResult.attempts,
          remainingAttempts: 0,
          remainingSeconds: failResult.remainingSeconds
        });
      }
      return res.status(401).json({
        error: `Sai thông tin đăng nhập! Đã sai ${failResult.attempts}/${MAX_ATTEMPTS} lần.`,
        locked: false,
        attempts: failResult.attempts,
        remainingAttempts: failResult.remainingAttempts,
        failWindowRemainingSeconds: failResult.failWindowRemainingSeconds
      });
    }

    const staff = result.records[0].get('s').properties;

    if (staff.status !== 'ACTIVE') {
      return res.status(403).json({ error: `Tài khoản nhân viên ${staffId} không ở trạng thái hoạt động` });
    }

    const isMatch = await bcrypt.compare(password, staff.passwordHash);
    if (!isMatch) {
      const failResult = await recordStaffLoginFailure(staffId, req);
      await publishEvent('STAFF_LOGIN_FAIL', {
        accountId: staffId,
        ip: getClientIp(req),
        detail: `Đăng nhập nhân viên thất bại: Sai mật khẩu (lần ${failResult.attempts}/${MAX_ATTEMPTS})`
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
          error: `Nhân viên ${staffId} đã bị khóa 5 phút do đăng nhập sai ${failResult.attempts} lần!`,
          locked: true,
          attempts: failResult.attempts,
          remainingAttempts: 0,
          remainingSeconds: failResult.remainingSeconds
        });
      }
      return res.status(401).json({
        error: `Sai mật khẩu! Đã sai ${failResult.attempts}/${MAX_ATTEMPTS} lần. Còn ${failResult.remainingAttempts} lần thử.`,
        locked: false,
        attempts: failResult.attempts,
        remainingAttempts: failResult.remainingAttempts,
        failWindowRemainingSeconds: failResult.failWindowRemainingSeconds
      });
    }

    // Đăng nhập thành công: Xóa bộ đếm sai
    await redis.del(`login:fail:staff:${staffId}`);

    // Tạo phiên có vai trò
    const token = crypto.randomBytes(24).toString('hex');
    const sessionKey = `session:${token}`;
    const clientIp = getClientIp(req);
    const userAgent = req.headers['user-agent'] || 'Unknown';

    const sessionData = {
      subjectType: 'STAFF',
      subjectId: staff.staffId,
      role: staff.role,
      createdAt: Date.now(),
      ip: clientIp,
      userAgent
    };

    await redis.set(sessionKey, JSON.stringify(sessionData), 'EX', SESSION_TTL);

    // Lưu cookie httpOnly và SameSite=Strict
    res.cookie('token', token, {
      httpOnly: true,
      sameSite: 'strict',
      maxAge: SESSION_TTL * 1000
    });

    await publishEvent('STAFF_LOGIN_OK', {
      accountId: staff.staffId,
      ip: clientIp,
      detail: `Nhân viên ${staff.staffId} (${staff.fullName} - ${staff.role}) đăng nhập thành công`
    });

    return res.json({
      message: `Đăng nhập thành công nhân viên ${staff.staffId} (${staff.fullName})`,
      token,
      sessionTtlSeconds: SESSION_TTL,
      staff: {
        staffId: staff.staffId,
        fullName: staff.fullName,
        role: staff.role,
        status: staff.status,
        createdAt: staff.createdAt
      }
    });
  } catch (err) {
    console.error('[Staff Login] Lỗi:', err.message);
    return res.status(500).json({ error: 'Lỗi máy chủ khi xử lý đăng nhập nhân viên' });
  } finally {
    await session.close();
  }
});

/**
 * GET /api/staff/me
 * Thông tin nhân viên hiện tại đang đăng nhập
 */
router.get('/me', requireRole('ADMIN', 'ANALYST'), async (req, res) => {
  const session = driver.session();
  try {
    const result = await session.run(
      `MATCH (s:Staff {staffId: $staffId}) RETURN s`,
      { staffId: req.sessionUser.subjectId }
    );
    if (result.records.length === 0) {
      return res.status(404).json({ error: 'Không tìm thấy thông tin nhân viên' });
    }
    const staff = result.records[0].get('s').properties;
    return res.json({
      staff: {
        staffId: staff.staffId,
        fullName: staff.fullName,
        role: staff.role,
        status: staff.status,
        createdAt: staff.createdAt
      }
    });
  } catch (err) {
    console.error('[Staff Me] Lỗi:', err.message);
    return res.status(500).json({ error: 'Lỗi máy chủ khi lấy thông tin nhân viên' });
  } finally {
    await session.close();
  }
});

/**
 * POST /api/staff/logout
 * Đăng xuất nhân viên
 */
router.post('/logout', requireSession, async (req, res) => {
  try {
    if (req.sessionToken) {
      await redis.del(`session:${req.sessionToken}`);
    }
    res.clearCookie('token');
    return res.json({ message: 'Đăng xuất thành công' });
  } catch (err) {
    console.error('[Staff Logout] Lỗi:', err.message);
    return res.status(500).json({ error: 'Lỗi khi đăng xuất' });
  }
});

/**
 * GET /api/staff/audit?limit=100
 * Xem nhật ký thao tác ghi dữ liệu của nhân viên từ Redis Stream audit:log (Chỉ ADMIN)
 */
router.get('/audit', requireRole('ADMIN'), async (req, res) => {
  try {
    const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100));
    const logs = await getAuditLogs(limit);
    return res.json({
      count: logs.length,
      limit,
      logs
    });
  } catch (err) {
    console.error('[GET /api/staff/audit] Lỗi:', err.message);
    return res.status(500).json({ error: 'Lỗi khi tải nhật ký kiểm toán: ' + err.message });
  }
});

module.exports = router;
