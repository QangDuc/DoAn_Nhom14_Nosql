/**
 * Quản lý sự kiện bảo mật hệ thống qua Redis Stream (security:events)
 * Hỗ trợ publishEvent non-blocking, XADD MAXLEN ~ 1000
 */

const redis = require('../config/redis');

/**
 * Phát sự kiện bảo mật vào Redis Stream security:events
 * Các loại sự kiện chuẩn:
 * - LOGIN_FAIL
 * - LOGIN_OK
 * - ACCOUNT_LOCKED
 * - IP_BLOCKED
 * - ACCOUNT_FROZEN
 * - CYCLE_DETECTED
 * - TX_BLOCKED
 * - SESSION_REVOKED
 */
async function publishEvent(type, fields = {}) {
  try {
    const accountId = String(fields.accountId || 'SYSTEM');
    const ip = String(fields.ip || '127.0.0.1');
    const detail = String(fields.detail || '');
    const ts = String(fields.ts || Date.now());

    await redis.xadd(
      'security:events',
      'MAXLEN', '~', 1000,
      '*',
      'type', String(type),
      'accountId', accountId,
      'ip', ip,
      'detail', detail,
      'ts', ts
    );
  } catch (_) {
    // Tuyệt đối không để lỗi Redis/Stream làm sập hoặc ảnh hưởng luồng chính
  }
}

/**
 * Chuyển đổi một phần tử mảng từ XREVRANGE/XREAD thành đối tượng sự kiện
 * [id, ['type', 'LOGIN_FAIL', 'accountId', 'ACC001', ...]] -> { id, type, accountId, ip, detail, ts }
 */
function parseStreamEntry(entry) {
  if (!entry || !Array.isArray(entry) || entry.length < 2) return null;
  const [id, rawFields] = entry;
  const obj = {
    id,
    type: 'UNKNOWN',
    accountId: '',
    ip: '',
    detail: '',
    ts: Date.now()
  };

  if (Array.isArray(rawFields)) {
    for (let i = 0; i < rawFields.length; i += 2) {
      const k = rawFields[i];
      const v = rawFields[i + 1];
      if (k === 'ts') {
        obj.ts = Number(v) || v;
      } else if (k in obj) {
        obj[k] = v;
      }
    }
  }
  return obj;
}

module.exports = {
  publishEvent,
  parseStreamEntry
};

