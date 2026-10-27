const redis = require('../config/redis');
const { publishEvent } = require('../services/events');

const SESSION_TTL = Number(process.env.SESSION_TTL_SECONDS) || 3600;

/**
 * Middleware kiểm tra phiên đăng nhập bằng Redis (Bearer token hoặc Cookie)
 * Giá trị session:{token} là JSON {subjectType: "CUSTOMER" | "STAFF", subjectId, role, createdAt, ip}
 */
async function requireSession(req, res, next) {
  try {
    let token = null;
    const authHeader = req.headers['authorization'];
    if (authHeader && authHeader.startsWith('Bearer ')) {
      token = authHeader.substring(7).trim();
    } else if (req.cookies && req.cookies.token) {
      token = req.cookies.token;
    }

    if (!token) {
      return res.status(401).json({ error: 'Yêu cầu đăng nhập (Thiếu token phiên)' });
    }

    const sessionKey = `session:${token}`;
    const rawVal = await redis.get(sessionKey);

    if (!rawVal) {
      return res.status(401).json({ error: 'Phiên đăng nhập không tồn tại hoặc đã hết hạn' });
    }

    let parsed = {};
    try {
      parsed = JSON.parse(rawVal);
    } catch (_) {
      parsed = { accountId: rawVal };
    }

    const accountId = parsed.accountId || parsed.subjectId || parsed.staffId;
    const role = parsed.role || 'CUSTOMER';
    const createdAt = parsed.createdAt || Date.now();
    const ip = parsed.ip || (req.ip || '127.0.0.1');

    // Gia hạn TTL cho phiên
    await redis.expire(sessionKey, SESSION_TTL);

    req.sessionToken = token;
    req.sessionAccountId = accountId;
    req.sessionRole = role;
    req.sessionMeta = parsed;
    req.sessionUser = {
      accountId,
      subjectId: accountId,
      subjectType: role,
      role,
      createdAt,
      ip
    };

    next();
  } catch (err) {
    console.error('[Session Middleware] Lỗi:', err.message);
    return res.status(500).json({ error: 'Lỗi kiểm tra phiên đăng nhập' });
  }
}

/**
 * Middleware phân quyền dựa theo vai trò (ADMIN, ANALYST, CUSTOMER)
 * Tự động xác thực phiên nếu chưa chạy requireSession.
 * CUSTOMER chỉ được gọi route của chính mình (:accountId hoặc fromAccountId phải khớp).
 */
function requireRole(...roles) {
  return async (req, res, next) => {
    try {
      if (!req.sessionUser) {
        let authErr = null;
        await new Promise((resolve) => {
          requireSession(req, res, (err) => {
            if (err) authErr = err;
            resolve();
          });
        });
        if (authErr) return next(authErr);
        if (res.headersSent) return;
      }

      if (!req.sessionUser) {
        return; // requireSession đã gửi response 401
      }

      const user = req.sessionUser;

      // Kiểm tra vai trò được phép
      if (roles.length > 0 && !roles.includes(user.role)) {
        return res.status(403).json({
          error: `Từ chối truy cập: Vai trò ${user.role} không có quyền thực hiện thao tác này (yêu cầu: ${roles.join(', ')})`
        });
      }

      // Khách hàng (CUSTOMER) chỉ thao tác trên tài khoản của chính mình
      if (user.role === 'CUSTOMER') {
        const targetAccountId = req.params.accountId;
        if (targetAccountId && targetAccountId !== user.subjectId) {
          return res.status(403).json({
            error: `Từ chối truy cập: Bạn không có quyền thao tác trên tài khoản khác (${targetAccountId})`
          });
        }
        if (req.body && req.body.fromAccountId && req.body.fromAccountId !== user.subjectId) {
          return res.status(403).json({
            error: `Từ chối truy cập: Bạn chỉ có thể tạo giao dịch từ tài khoản của chính mình`
          });
        }
      }

      next();
    } catch (err) {
      console.error('[requireRole] Lỗi:', err.message);
      return res.status(500).json({ error: 'Lỗi kiểm tra quyền hạn' });
    }
  };
}

/**
 * Thu hồi tất cả các phiên session:* của một accountId cụ thể (dùng SCAN)
 */
async function revokeAccountSessions(accountId) {
  if (!accountId) return 0;
  let cursor = '0';
  let revokedCount = 0;
  try {
    do {
      const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', 'session:*', 'COUNT', 100);
      cursor = nextCursor;
      for (const key of keys) {
        const val = await redis.get(key);
        if (!val) continue;
        let match = false;
        try {
          const parsed = JSON.parse(val);
          if (parsed.accountId === accountId || (parsed.subjectType === 'CUSTOMER' && parsed.subjectId === accountId)) {
            match = true;
          }
        } catch (_) {
          if (val === accountId) match = true;
        }
        if (match) {
          await redis.del(key);
          revokedCount++;
        }
      }
    } while (cursor !== '0');
  } catch (err) {
    console.error(`[revokeAccountSessions] Lỗi xóa phiên cho ${accountId}:`, err.message);
  }
  if (revokedCount > 0) {
    await publishEvent('SESSION_REVOKED', {
      accountId,
      ip: 'system',
      detail: `Thu hồi ${revokedCount} phiên của tài khoản ${accountId}`
    });
  }
  return revokedCount;
}

/**
 * Thu hồi tất cả các phiên session:* của một staffId cụ thể (dùng SCAN)
 */
async function revokeStaffSessions(staffId) {
  if (!staffId) return 0;
  let cursor = '0';
  let revokedCount = 0;
  try {
    do {
      const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', 'session:*', 'COUNT', 100);
      cursor = nextCursor;
      for (const key of keys) {
        const val = await redis.get(key);
        if (!val) continue;
        let match = false;
        try {
          const parsed = JSON.parse(val);
          if (parsed.subjectType === 'STAFF' && parsed.subjectId === staffId) {
            match = true;
          }
        } catch (_) {}
        if (match) {
          await redis.del(key);
          revokedCount++;
        }
      }
    } while (cursor !== '0');
  } catch (err) {
    console.error(`[revokeStaffSessions] Lỗi xóa phiên cho staff ${staffId}:`, err.message);
  }
  if (revokedCount > 0) {
    await publishEvent('SESSION_REVOKED', {
      accountId: staffId,
      ip: 'system',
      detail: `Thu hồi ${revokedCount} phiên của nhân viên ${staffId}`
    });
  }
  return revokedCount;
}

/**
 * Thu hồi phiên dựa trên sessionId (8 ký tự đầu của token)
 */
async function revokeSessionById(sessionId) {
  if (!sessionId) return 0;
  let cursor = '0';
  let revokedCount = 0;
  try {
    do {
      const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', 'session:*', 'COUNT', 100);
      cursor = nextCursor;
      for (const key of keys) {
        const token = key.replace('session:', '');
        if (token.startsWith(sessionId)) {
          await redis.del(key);
          revokedCount++;
        }
      }
    } while (cursor !== '0');
  } catch (err) {
    console.error(`[revokeSessionById] Lỗi xóa phiên ${sessionId}:`, err.message);
  }
  if (revokedCount > 0) {
    await publishEvent('SESSION_REVOKED', {
      accountId: 'UNKNOWN',
      ip: 'system',
      detail: `Thu hồi phiên ${sessionId}`
    });
  }
  return revokedCount;
}

module.exports = {
  requireSession,
  requireRole,
  revokeAccountSessions,
  revokeStaffSessions,
  revokeSessionById
};

