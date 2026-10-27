const express = require('express');
const redis = require('../config/redis');
const { requireRole } = require('../middleware/authMiddleware');
const { logAudit } = require('../services/audit');

const router = express.Router();

/**
 * GET /api/security/mode
 * Lấy chế độ chống gian lận hiện tại (ALERT hoặc BLOCK)
 */
router.get('/mode', requireRole('ADMIN', 'ANALYST'), async (req, res) => {
  try {
    const mode = (await redis.get('config:fraud_mode')) || 'ALERT';
    return res.json({ mode });
  } catch (err) {
    console.error('[GET /security/mode] Lỗi:', err.message);
    return res.status(500).json({ error: 'Lỗi khi lấy chế độ bảo mật' });
  }
});

/**
 * PUT /api/security/mode
 * Cập nhật chế độ chống gian lận (Chỉ ADMIN)
 */
router.put('/mode', requireRole('ADMIN'), async (req, res) => {
  try {
    const { mode } = req.body;
    if (!mode || !['ALERT', 'BLOCK'].includes(mode.toUpperCase())) {
      return res.status(400).json({ error: 'Mode không hợp lệ. Vui lòng chọn ALERT hoặc BLOCK.' });
    }

    const normalizedMode = mode.toUpperCase();
    await redis.set('config:fraud_mode', normalizedMode);

    await logAudit({
      actor: req.sessionUser?.subjectId || 'UNKNOWN',
      role: req.sessionUser?.role || 'ADMIN',
      action: 'UPDATE_SECURITY_MODE',
      target: normalizedMode,
      ip: req.sessionUser?.ip || req.ip || '127.0.0.1'
    });

    return res.json({
      message: `Đã chuyển chế độ bảo mật sang ${normalizedMode}`,
      mode: normalizedMode
    });
  } catch (err) {
    console.error('[PUT /security/mode] Lỗi:', err.message);
    return res.status(500).json({ error: 'Lỗi khi cập nhật chế độ bảo mật' });
  }
});

/**
 * GET /api/security/frozen
 * Lấy danh sách tất cả tài khoản đang bị đóng băng
 */
router.get('/frozen', requireRole('ADMIN', 'ANALYST'), async (req, res) => {
  try {
    const keys = await redis.keys('account:frozen:*');
    const frozenAccounts = [];

    for (const key of keys) {
      const accountId = key.replace('account:frozen:', '');
      const reason = await redis.get(key);
      const remainingSeconds = await redis.ttl(key);

      frozenAccounts.push({
        accountId,
        reason: reason || 'UNKNOWN',
        remainingSeconds: remainingSeconds > 0 ? remainingSeconds : 0
      });
    }

    // Sắp xếp theo mã tài khoản tăng dần
    frozenAccounts.sort((a, b) => a.accountId.localeCompare(b.accountId));

    return res.json({
      count: frozenAccounts.length,
      frozenAccounts
    });
  } catch (err) {
    console.error('[GET /security/frozen] Lỗi:', err.message);
    return res.status(500).json({ error: 'Lỗi khi lấy danh sách tài khoản đóng băng' });
  }
});

/**
 * POST /api/security/unfreeze/:id
 * Mở đóng băng tài khoản (xóa key account:frozen:{id}) (Chỉ ADMIN)
 */
router.post('/unfreeze/:id', requireRole('ADMIN'), async (req, res) => {
  try {
    const accountId = req.params.id;
    if (!accountId) {
      return res.status(400).json({ error: 'Thiếu mã accountId cần mở đóng băng' });
    }

    const key = `account:frozen:${accountId}`;
    const existed = await redis.del(key);

    await logAudit({
      actor: req.sessionUser?.subjectId || 'UNKNOWN',
      role: req.sessionUser?.role || 'ADMIN',
      action: 'UNFREEZE_ACCOUNT',
      target: accountId,
      ip: req.sessionUser?.ip || req.ip || '127.0.0.1'
    });

    return res.json({
      message: existed > 0 ? `Đã mở đóng băng tài khoản ${accountId}` : `Tài khoản ${accountId} không bị đóng băng`,
      accountId,
      unfrozen: existed > 0
    });
  } catch (err) {
    console.error('[POST /security/unfreeze] Lỗi:', err.message);
    return res.status(500).json({ error: 'Lỗi khi mở đóng băng tài khoản' });
  }
});

module.exports = router;

