/**
 * Route phục vụ kịch bản Trình diễn / Mô phỏng tấn công (Demo Attack)
 * Yêu cầu DEMO_MODE=true và quyền STAFF (ADMIN, ANALYST)
 */

const express = require('express');
const http = require('http');
const { requireRole } = require('../middleware/authMiddleware');

const router = express.Router();

// Danh sách 50 mật khẩu phổ biến nhất thế giới (tuyệt đối KHÔNG chứa mật khẩu đúng MatKhau@123)
const COMMON_DICTIONARY_PASSWORDS = [
  '123456', 'password', '12345678', 'qwerty', '123456789',
  '12345', '1234', '111111', '1234567', 'dragon',
  'welcome', '123123', 'admin', 'monkey', 'football',
  'letmein', 'sunshine', 'master', 'shadow', 'princess',
  'solo', 'starwars', 'superman', 'trustno1', 'killer',
  'login', 'mustang', 'secret', 'access', 'freedom',
  'computer', 'super', 'orange', 'apple', 'batman',
  'hunter2', 'soccer', 'ninja', 'hello', 'rookie',
  'charlie', 'phantom', 'galaxy', 'matrix', 'phoenix',
  'viper', 'tiger', 'pepper', 'bullet', 'target'
];

/**
 * Gửi request đăng nhập nội bộ đến máy chủ Express
 */
function callLocalLogin(port, accountId, password, demoIp) {
  return new Promise((resolve) => {
    const postData = JSON.stringify({ accountId, password });
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: '/api/auth/login',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData),
          'x-demo-ip': demoIp
        }
      },
      (res) => {
        let raw = '';
        res.on('data', chunk => raw += chunk);
        res.on('end', () => {
          let data = {};
          try {
            data = JSON.parse(raw);
          } catch (_) {}
          resolve({ status: res.statusCode, data });
        });
      }
    );
    req.on('error', (err) => {
      resolve({ status: 500, data: { error: err.message } });
    });
    req.write(postData);
    req.end();
  });
}

/**
 * POST /api/demo/attack
 * Mô phỏng Dictionary Attack (Dictionary Attack Simulation)
 * Body: { accountId, attempts, delayMs, mode: "single" | "distributed" }
 * Yêu cầu quyền ADMIN hoặc ANALYST và DEMO_MODE=true
 */
router.post('/attack', requireRole('ADMIN', 'ANALYST'), async (req, res) => {
  const isDemo = (process.env.DEMO_MODE === 'true') && req.headers['x-demo-mode'] !== 'false';
  if (!isDemo) {
    return res.status(403).json({
      error: 'Chức năng mô phỏng tấn công chỉ khả dụng khi DEMO_MODE=true trong file cấu hình .env'
    });
  }

  const { accountId, mode } = req.body;
  if (!accountId) {
    return res.status(400).json({ error: 'Vui lòng cung cấp accountId mục tiêu' });
  }

  const attempts = Math.min(100, Math.max(1, Number(req.body.attempts) || 50));
  const delayMs = Math.min(200, Math.max(0, Number(req.body.delayMs) || 100));
  const attackMode = mode === 'distributed' ? 'distributed' : 'single';
  const port = Number(process.env.PORT) || 3000;

  const startTime = Date.now();
  let count401 = 0;
  let count429 = 0;
  let lockedAtAttempt = null;
  let ipBlockedAtAttempt = null;

  for (let i = 1; i <= attempts; i++) {
    const password = COMMON_DICTIONARY_PASSWORDS[(i - 1) % COMMON_DICTIONARY_PASSWORDS.length];
    
    // Tạo địa chỉ IP theo chế độ:
    // - single: cố định 1 IP duy nhất
    // - distributed: đổi IP luân phiên theo từng lượt (tấn công phân tán / botnet 2 node)
    const demoIp = attackMode === 'distributed'
      ? `198.51.100.${(i % 2) + 1}`
      : '203.0.113.88';

    const loginRes = await callLocalLogin(port, accountId, password, demoIp);

    if (loginRes.status === 401) {
      count401++;
    } else if (loginRes.status === 429) {
      count429++;

      // Ghi nhận lần thử đầu tiên tài khoản bị khóa
      if (!lockedAtAttempt && (loginRes.data.locked || loginRes.data.error?.includes('KHÓA') || loginRes.data.error?.includes('tạm khóa'))) {
        lockedAtAttempt = i;
      }

      // Ghi nhận lần thử đầu tiên IP bị chặn
      if (!ipBlockedAtAttempt && (loginRes.data.scope === 'ip' || loginRes.data.blocked)) {
        ipBlockedAtAttempt = i;
      }
    }

    if (delayMs > 0 && i < attempts) {
      await new Promise(r => setTimeout(r, delayMs));
    }
  }

  const durationMs = Date.now() - startTime;

  return res.json({
    accountId,
    mode: attackMode,
    attempts,
    status401: count401,
    status429: count429,
    lockedAtAttempt,
    ipBlockedAtAttempt,
    durationMs
  });
});

module.exports = router;
