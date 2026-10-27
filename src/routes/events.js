/**
 * Route quản lý sự kiện bảo mật hệ thống qua Redis Stream
 * Cung cấp API truy vấn lịch sử và SSE Stream thời gian thực
 */

const express = require('express');
const redis = require('../config/redis');
const { requireRole } = require('../middleware/authMiddleware');
const { parseStreamEntry } = require('../services/events');

const router = express.Router();

/**
 * GET /api/events?limit=50
 * Xem danh sách các sự kiện bảo mật gần nhất từ Redis Stream
 */
router.get('/', requireRole('ADMIN', 'ANALYST'), async (req, res) => {
  try {
    if (redis.isUsingFallback?.() && process.env.ALLOW_FALLBACK_ANALYTICS !== 'true' && req.headers['x-allow-fallback'] !== 'true') {
      return res.status(503).json({ error: 'Cần Neo4j/Redis thật' });
    }

    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
    const rawEntries = await redis.xrevrange('security:events', '+', '-', 'COUNT', limit);

    const events = (rawEntries || [])
      .map(entry => parseStreamEntry(entry))
      .filter(Boolean);

    return res.json({
      count: events.length,
      events
    });
  } catch (err) {
    console.error('[GET /api/events] Lỗi:', err.message);
    return res.status(500).json({ error: 'Lỗi truy vấn sự kiện từ Redis Stream: ' + err.message });
  }
});

/**
 * GET /api/events/stream
 * Server-Sent Events (SSE) phát trực tiếp sự kiện bảo mật từ Redis Stream
 */
router.get('/stream', requireRole('ADMIN', 'ANALYST'), async (req, res) => {
  if (redis.isUsingFallback?.() && process.env.ALLOW_FALLBACK_ANALYTICS !== 'true' && req.headers['x-allow-fallback'] !== 'true') {
    return res.status(503).json({ error: 'Cần Neo4j/Redis thật' });
  }

  // Thiết lập SSE Headers chuẩn
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });

  if (res.flushHeaders) {
    res.flushHeaders();
  }

  // Khởi tạo kết nối Redis duplicate chuyên biệt cho stream đọc blocking
  const subRedis = typeof redis.duplicate === 'function' ? redis.duplicate() : redis;
  let isClosed = false;

  // Lấy Last-Event-ID từ header hoặc query
  const lastEventId = req.headers['last-event-id'] || req.query.lastEventId;
  let currentLastId = lastEventId ? String(lastEventId) : '$';

  // Heartbeat định kỳ 15 giây giữ kết nối
  const heartbeatTimer = setInterval(() => {
    if (!isClosed) {
      try {
        res.write(': heartbeat\n\n');
      } catch (_) {}
    }
  }, 15000);

  // Đóng kết nối duplicate ngay lập tức khi client ngắt
  req.on('close', () => {
    isClosed = true;
    clearInterval(heartbeatTimer);
    try {
      if (typeof subRedis.disconnect === 'function') {
        subRedis.disconnect();
      } else if (typeof subRedis.quit === 'function') {
        subRedis.quit();
      }
    } catch (_) {}
  });

  // Gửi thông báo kết nối thành công ban đầu
  res.write(`: connected at ${new Date().toISOString()}\n\n`);

  // Vòng lặp XREAD BLOCK đón sự kiện mới
  (async () => {
    while (!isClosed) {
      try {
        const reply = await subRedis.xread('BLOCK', 5000, 'STREAMS', 'security:events', currentLastId);
        if (isClosed) break;

        if (reply && Array.isArray(reply) && reply.length > 0) {
          const streamData = reply[0];
          const entries = streamData[1];
          if (Array.isArray(entries)) {
            for (const entry of entries) {
              currentLastId = entry[0];
              const eventData = parseStreamEntry(entry);
              if (eventData) {
                res.write(`id: ${eventData.id}\n`);
                res.write(`event: security_event\n`);
                res.write(`data: ${JSON.stringify(eventData)}\n\n`);
              }
            }
          }
        }
      } catch (err) {
        if (isClosed) break;
        // Chờ ngắn trước khi thử lại nếu có gián đoạn tạm thời
        await new Promise(r => setTimeout(r, 1000));
      }
    }
  })().catch(() => {});
});

module.exports = router;

