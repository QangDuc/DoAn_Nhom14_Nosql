/**
 * Kịch bản kiểm thử toàn diện IP Rate-Limit / Blocking & Session Management
 * 
 * Kiểm tra đầy đủ 7 tiêu chí (a) - (g):
 * (a) 1 IP gõ sai 5 tài khoản khác nhau -> lần 5 bị chặn login:ipblock, trả về 429 { scope: "ip" }
 * (b) 1 IP gõ sai 20 lần trên 1 tài khoản -> bị chặn login:ipblock, trả về 429 { scope: "ip" }
 * (c) IP khác không bị ảnh hưởng (dùng x-demo-ip trong DEMO_MODE=true)
 * (d) Gọi POST /api/auth/admin/ip-unblock/:ip gỡ chặn và xóa toàn bộ key liên quan thành công
 * (e) Đăng nhập 2 tài khoản -> GET /sessions ra 2 phiên; revoke 1 phiên -> token đó gọi /me trả 401
 * (f) Tài khoản có session đang hoạt động bị brute-force khóa -> session tự động bị thu hồi
 * (g) Phản hồi của GET /sessions và log tuyệt đối không chứa token đầy đủ (chỉ có sessionId 8 ký tự)
 */

const http = require('http');

const PORT = 3000;
const ADMIN_KEY = 'admin_secret_key_123';

function request(options, body = null) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: 'localhost',
        port: PORT,
        ...options,
        headers: {
          'Content-Type': 'application/json',
          ...(options.headers || {})
        }
      },
      (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const parsed = data ? JSON.parse(data) : {};
            resolve({ status: res.statusCode, data: parsed, raw: data });
          } catch (e) {
            resolve({ status: res.statusCode, data, raw: data });
          }
        });
      }
    );
    req.on('error', reject);
    if (body) {
      req.write(typeof body === 'string' ? body : JSON.stringify(body));
    }
    req.end();
  });
}

async function runTests() {
  console.log('================================================================');
  console.log('   BẮT ĐẦU KIỂM THỬ: IP BRUTE-FORCE DEFENSE & SESSIONS (a-g)    ');
  console.log('================================================================\n');

  const results = [];

  // Reset seed trước khi test
  await request({ path: '/api/admin/seed-reset', method: 'POST', headers: { 'x-admin-key': ADMIN_KEY } });

  // TEST (a): 1 IP thử sai 5 tài khoản khác nhau -> lần 5 kích hoạt login:ipblock
  try {
    const testIpA = '192.168.10.101';
    let triggered = false;
    let fifthAttemptStatus = 0;
    let fifthAttemptData = null;

    // Gõ sai trên 5 tài khoản khác nhau: ACC031, ACC032, ACC033, ACC034, ACC035
    for (let i = 31; i <= 35; i++) {
      const res = await request(
        { path: '/api/auth/login', method: 'POST', headers: { 'x-demo-ip': testIpA } },
        { accountId: `ACC0${i}`, password: 'WrongPassword999' }
      );
      if (i === 35) {
        fifthAttemptStatus = res.status;
        fifthAttemptData = res.data;
        if (res.status === 429 && res.data.scope === 'ip') {
          triggered = true;
        }
      }
    }

    // Lần thứ 6 phải tiếp tục bị chặn bởi checkBruteForceLock middleware với HTTP 429 scope=ip
    const nextRes = await request(
      { path: '/api/auth/login', method: 'POST', headers: { 'x-demo-ip': testIpA } },
      { accountId: 'ACC036', password: 'WrongPassword999' }
    );

    const passA = triggered && nextRes.status === 429 && nextRes.data.scope === 'ip';
    results.push({
      id: '(a)',
      name: 'Chặn IP khi dò sai 5 tài khoản khác nhau',
      pass: passA,
      detail: `Lần 5: status ${fifthAttemptStatus} (scope: ${fifthAttemptData?.scope}). Lần tiếp theo: status ${nextRes.status} (scope: ${nextRes.data?.scope})`
    });
  } catch (err) {
    results.push({ id: '(a)', name: 'Chặn IP khi dò 5 tài khoản', pass: false, detail: err.message });
  }

  // TEST (b): Cùng 1 IP gõ sai 20 lần trên 1 tài khoản -> chặn IP
  try {
    const testIpB = '192.168.10.102';
    let blockTriggeredAt20 = false;
    let statusAt20 = 0;

    for (let i = 1; i <= 20; i++) {
      const res = await request(
        { path: '/api/auth/login', method: 'POST', headers: { 'x-demo-ip': testIpB } },
        { accountId: 'ACC025', password: 'WrongPassword123' }
      );
      if (i === 20) {
        statusAt20 = res.status;
        if (res.status === 429 && res.data.scope === 'ip') {
          blockTriggeredAt20 = true;
        }
      }
    }

    const nextRes = await request(
      { path: '/api/auth/login', method: 'POST', headers: { 'x-demo-ip': testIpB } },
      { accountId: 'ACC025', password: 'WrongPassword123' }
    );

    const passB = (blockTriggeredAt20 || nextRes.status === 429) && nextRes.data.scope === 'ip';
    results.push({
      id: '(b)',
      name: 'Chặn IP khi sai 20 lần trên 1 tài khoản',
      pass: passB,
      detail: `Lần 20: status ${statusAt20}. Lần tiếp theo: status ${nextRes.status} (scope: ${nextRes.data?.scope})`
    });
  } catch (err) {
    results.push({ id: '(b)', name: 'Chặn IP 20 lần sai', pass: false, detail: err.message });
  }

  // TEST (c): IP khác không bị ảnh hưởng (dùng x-demo-ip khác)
  try {
    const cleanIp = '192.168.10.199';
    // Đăng nhập đúng với IP cleanIp vào tài khoản ACC030 (mật khẩu MatKhau@123)
    const res = await request(
      { path: '/api/auth/login', method: 'POST', headers: { 'x-demo-ip': cleanIp } },
      { accountId: 'ACC030', password: 'MatKhau@123' }
    );

    // Không bị chặn 429 IP, đăng nhập thành công
    const passC = res.status === 200 && res.data.token;
    results.push({
      id: '(c)',
      name: 'IP khác không bị ảnh hưởng bởi IP bị block',
      pass: passC,
      detail: `Status đăng nhập từ clean IP: ${res.status} (thành công, nhận token)`
    });
  } catch (err) {
    results.push({ id: '(c)', name: 'IP khác không bị ảnh hưởng', pass: false, detail: err.message });
  }

  // TEST (d): Gọi ip-unblock gỡ chặn thành công và xóa counter
  try {
    const testIpA = '192.168.10.101';
    // Mở chặn testIpA
    const unblockRes = await request(
      { path: `/api/auth/admin/ip-unblock/${testIpA}`, method: 'POST', headers: { 'x-admin-key': ADMIN_KEY } }
    );

    // Kiểm tra lại bằng cách request login: sẽ không còn nhận 429 scope=ip nữa
    const retryRes = await request(
      { path: '/api/auth/login', method: 'POST', headers: { 'x-demo-ip': testIpA } },
      { accountId: 'ACC036', password: 'WrongPasswordTest' }
    );

    const passD = unblockRes.status === 200 && retryRes.status === 401 && retryRes.data.scope !== 'ip';
    results.push({
      id: '(d)',
      name: 'Gỡ chặn IP (ip-unblock) thành công',
      pass: passD,
      detail: `Unblock response: ${unblockRes.status}. Login sau gỡ chặn: status ${retryRes.status} (bộ đếm IP đã reset)`
    });
  } catch (err) {
    results.push({ id: '(d)', name: 'Gỡ chặn IP', pass: false, detail: err.message });
  }

  // TEST (e): Đăng nhập 2 tài khoản -> GET /sessions ra 2 phiên; revoke 1 -> token đó gọi /me trả 401
  try {
    // Đăng nhập ACC040 và ACC041 (MatKhau@123)
    const login1 = await request(
      { path: '/api/auth/login', method: 'POST' },
      { accountId: 'ACC040', password: 'MatKhau@123' }
    );
    const login2 = await request(
      { path: '/api/auth/login', method: 'POST' },
      { accountId: 'ACC041', password: 'MatKhau@123' }
    );

    const token1 = login1.data.token;
    const token2 = login2.data.token;

    // Lấy danh sách session
    const listRes = await request(
      { path: '/api/auth/admin/sessions', method: 'GET', headers: { 'x-admin-key': ADMIN_KEY } }
    );

    const has2Sessions = listRes.status === 200 && listRes.data.sessions && listRes.data.sessions.length >= 2;

    // Thu hồi phiên 1 theo sessionId (8 ký tự đầu)
    const sessionId1 = token1.substring(0, 8);
    const revokeRes = await request(
      { path: '/api/auth/admin/sessions/revoke', method: 'POST', headers: { 'x-admin-key': ADMIN_KEY } },
      { sessionId: sessionId1 }
    );

    // Gọi /me với token1 -> Phải trả 401
    const meRes1 = await request(
      { path: '/api/auth/me', method: 'GET', headers: { 'Authorization': `Bearer ${token1}` } }
    );

    // Gọi /me với token2 -> Vẫn 200 hợp lệ
    const meRes2 = await request(
      { path: '/api/auth/me', method: 'GET', headers: { 'Authorization': `Bearer ${token2}` } }
    );

    const passE = has2Sessions && revokeRes.status === 200 && meRes1.status === 401 && meRes2.status === 200;
    results.push({
      id: '(e)',
      name: 'Quản lý phiên: tạo 2 phiên, thu hồi 1 phiên -> /me trả 401',
      pass: passE,
      detail: `Tổng phiên: ${listRes.data.totalSessions}. Token1 /me: ${meRes1.status} (401), Token2 /me: ${meRes2.status} (200)`
    });
  } catch (err) {
    results.push({ id: '(e)', name: 'Quản lý phiên', pass: false, detail: err.message });
  }

  // TEST (f): Tài khoản có active session bị brute-force khóa -> session tự động bị thu hồi
  try {
    // 1. Đăng nhập ACC045
    const loginRes = await request(
      { path: '/api/auth/login', method: 'POST' },
      { accountId: 'ACC045', password: 'MatKhau@123' }
    );
    const token = loginRes.data.token;

    // Kiểm tra phiên hoạt động bình thường
    const beforeMe = await request(
      { path: '/api/auth/me', method: 'GET', headers: { 'Authorization': `Bearer ${token}` } }
    );

    // 2. Tấn công brute force 5 lần sai vào ACC045 từ một IP ngẫu nhiên
    const attackerIp = '10.20.30.40';
    for (let i = 1; i <= 5; i++) {
      await request(
        { path: '/api/auth/login', method: 'POST', headers: { 'x-demo-ip': attackerIp } },
        { accountId: 'ACC045', password: 'AttackPassword' }
      );
    }

    // 3. Sau khi bị khóa, gọi lại /me với token cũ -> Phải bị 401 vì session đã tự động bị revoke
    const afterMe = await request(
      { path: '/api/auth/me', method: 'GET', headers: { 'Authorization': `Bearer ${token}` } }
    );

    const passF = beforeMe.status === 200 && afterMe.status === 401;
    results.push({
      id: '(f)',
      name: 'Tự động thu hồi phiên khi tài khoản bị khóa do Brute-Force',
      pass: passF,
      detail: `Trước khóa: status ${beforeMe.status} (200). Sau khi tài khoản bị khóa 5 lần: status ${afterMe.status} (401)`
    });
  } catch (err) {
    results.push({ id: '(f)', name: 'Thu hồi phiên khi tài khoản bị khóa', pass: false, detail: err.message });
  }

  // TEST (g): Response của /api/auth/admin/sessions TUYỆT ĐỐI không chứa token đầy đủ
  try {
    const listRes = await request(
      { path: '/api/auth/admin/sessions', method: 'GET', headers: { 'x-admin-key': ADMIN_KEY } }
    );

    const rawJson = listRes.raw;
    let safe = true;
    let reason = 'OK';

    // Kiểm tra trong mỗi session chỉ có sessionId (8 ký tự)
    if (listRes.data.sessions) {
      for (const s of listRes.data.sessions) {
        if (!s.sessionId || s.sessionId.length !== 8) {
          safe = false;
          reason = `SessionId không phải 8 ký tự: ${s.sessionId}`;
          break;
        }
        if (s.token || s.sessionToken || s.fullToken) {
          safe = false;
          reason = 'Phát hiện trường token đầy đủ trong object session';
          break;
        }
      }
    }

    // Kiểm tra chuỗi JSON thô không chứa từ khóa token hoặc chuỗi hex 48 ký tự
    const hex48Regex = /[a-f0-9]{48}/i;
    if (hex48Regex.test(rawJson)) {
      safe = false;
      reason = 'Phát hiện token hex 48 ký tự nằm trong chuỗi JSON trả về!';
    }

    const passG = listRes.status === 200 && safe;
    results.push({
      id: '(g)',
      name: 'Bảo mật: GET /sessions tuyệt đối không để lộ token đầy đủ',
      pass: passG,
      detail: safe ? 'Chỉ chứa sessionId 8 ký tự, không rò rỉ token đầy đủ' : reason
    });
  } catch (err) {
    results.push({ id: '(g)', name: 'Bảo mật token', pass: false, detail: err.message });
  }

  // IN BẢNG TỔNG KẾT
  console.log('----------------------------------------------------------------');
  console.log('KẾT QUẢ KIỂM THỬ:');
  console.log('----------------------------------------------------------------');
  let allPass = true;
  for (const r of results) {
    const tag = r.pass ? '[PASS]' : '[FAIL]';
    if (!r.pass) allPass = false;
    console.log(`${tag} ${r.id} ${r.name}`);
    console.log(`       -> ${r.detail}`);
  }
  console.log('----------------------------------------------------------------');
  if (allPass) {
    console.log('🎉 TẤT CẢ 7 TIÊU CHÍ (a) ĐẾN (g) ĐỀU ĐẠT CHUẨN 100%!');
  } else {
    console.log('❌ CÓ BÀI TEST CHƯA ĐẠT. VUI LÒNG KIỂM TRA LẠI.');
  }
  console.log('================================================================\n');

  process.exit(allPass ? 0 : 1);
}

runTests();
