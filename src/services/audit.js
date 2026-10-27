const redis = require('../config/redis');

/**
 * Ghi nhật ký thao tác ghi dữ liệu của nhân viên vào Redis Stream audit:log
 * Schema: { actor, role, action, target, ip, ts }
 * Giới hạn stream: MAXLEN ~ 5000
 */
async function logAudit({ actor, role, action, target, ip }) {
  try {
    const ts = String(Date.now());
    await redis.xadd(
      'audit:log',
      'MAXLEN',
      '~',
      '5000',
      '*',
      'actor',
      String(actor || 'SYSTEM'),
      'role',
      String(role || 'ADMIN'),
      'action',
      String(action || 'UNKNOWN'),
      'target',
      String(target || 'SYSTEM'),
      'ip',
      String(ip || '127.0.0.1'),
      'ts',
      ts
    );
  } catch (err) {
    console.error('[Audit Service] Lỗi ghi nhật ký audit:log:', err.message);
  }
}

/**
 * Đọc nhật ký thao tác từ Redis Stream audit:log
 */
async function getAuditLogs(limit = 100) {
  try {
    const rawEntries = await redis.xrevrange('audit:log', '+', '-', 'COUNT', limit);
    if (!rawEntries || !Array.isArray(rawEntries)) return [];

    return rawEntries.map(([id, fields]) => {
      const obj = { id };
      for (let i = 0; i < fields.length; i += 2) {
        obj[fields[i]] = fields[i + 1];
      }
      return {
        id: obj.id,
        actor: obj.actor,
        role: obj.role,
        action: obj.action,
        target: obj.target,
        ip: obj.ip,
        ts: Number(obj.ts) || 0,
        time: obj.ts ? new Date(Number(obj.ts)).toISOString() : null
      };
    });
  } catch (err) {
    console.error('[Audit Service] Lỗi truy vấn audit:log:', err.message);
    return [];
  }
}

module.exports = {
  logAudit,
  getAuditLogs
};

