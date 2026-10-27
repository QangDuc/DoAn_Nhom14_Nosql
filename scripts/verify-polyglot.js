const http = require('http');
const redis = require('../src/config/redis');

const ADMIN_KEY = 'admin_secret_key_123';

function request(options, postData = null) {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        let parsed = data;
        try {
          parsed = JSON.parse(data);
        } catch (_) {}
        resolve({ status: res.statusCode, headers: res.headers, body: parsed });
      });
    });
    req.on('error', reject);
    if (postData) {
      req.write(typeof postData === 'string' ? postData : JSON.stringify(postData));
    }
    req.end();
  });
}

async function loginAccount(accountId, password = 'MatKhau@123') {
  const res = await request({
    hostname: 'localhost',
    port: 3000,
    path: '/api/auth/login',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' }
  }, { accountId, password });
  return res.body.token;
}

async function runTests() {
  console.log('========================================================');
  console.log('BẮT ĐẦU KIỂM THỬ TÍNH NĂNG POLYGLOT (NEO4J + REDIS)');
  console.log('========================================================\n');

  // 0. Reset demo data
  console.log('0. Reset dữ liệu demo về trạng thái ban đầu...');
  const resetRes = await request({
    hostname: 'localhost',
    port: 3000,
    path: '/api/admin/seed-reset',
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-admin-key': ADMIN_KEY }
  });
  console.log(`Reset status: ${resetRes.status}\n`);

  let testPassed = { a: false, b: false, c: false, d: false };

  // ==========================================
  // TEST (A): 5 WRONG PASSWORDS -> 423 ON TRANSFER
  // ==========================================
  console.log('--- TEST (A): Đăng nhập sai 5 lần trên ACC025 -> đóng băng -> chuyển tiền trả 423 ---');
  // Lấy token đăng nhập hợp lệ cho ACC025 trước
  const tokenAcc25 = await loginAccount('ACC025');
  console.log('Đã đăng nhập cấp phiên ban đầu cho ACC025, token:', tokenAcc25 ? 'OK' : 'FAIL');

  // Gửi 5 lần mật khẩu sai
  for (let i = 1; i <= 5; i++) {
    const loginRes = await request({
      hostname: 'localhost',
      port: 3000,
      path: '/api/auth/login',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }, { accountId: 'ACC025', password: 'WrongPassword999' });
    console.log(`Lần ${i}: HTTP ${loginRes.status} - remainingAttempts: ${loginRes.body.remainingAttempts}`);
  }

  // Kiểm tra danh sách frozen
  const frozenListRes = await request({
    hostname: 'localhost',
    port: 3000,
    path: '/api/security/frozen',
    method: 'GET',
    headers: { 'x-admin-key': ADMIN_KEY }
  });
  console.log('GET /api/security/frozen:', JSON.stringify(frozenListRes.body));
  const acc25Frozen = (frozenListRes.body.frozenAccounts || []).find(f => f.accountId === 'ACC025');

  // Thử chuyển tiền đến tài khoản bị đóng băng ACC025 (dùng token của ACC026)
  const tokenAcc26 = await loginAccount('ACC026');
  const txResA = await request({
    hostname: 'localhost',
    port: 3000,
    path: '/api/transactions',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${tokenAcc26}`
    }
  }, {
    fromAccountId: 'ACC026',
    toAccountId: 'ACC025',
    amount: 1000000,
    note: 'Chuyển tiền thử nghiệm khi bị đóng băng'
  });

  console.log(`Chuyển tiền từ ACC025: HTTP ${txResA.status} - Body:`, JSON.stringify(txResA.body));

  if (acc25Frozen && acc25Frozen.reason === 'BRUTE_FORCE' && txResA.status === 423 && txResA.body.frozenAccount === 'ACC025') {
    testPassed.a = true;
    console.log('==> TEST (A) PASS!\n');
  } else {
    console.log('==> TEST (A) FAIL!\n');
  }

  // ==========================================
  // TEST (B): CREATE CYCLE ACC030->031->032->030 IN ALERT -> 3 ACCOUNTS FROZEN
  // ==========================================
  console.log('--- TEST (B): Tạo chu trình ACC030 -> ACC031 -> ACC032 -> ACC030 ở chế độ ALERT ---');
  // Đảm bảo mode là ALERT
  await request({
    hostname: 'localhost',
    port: 3000,
    path: '/api/security/mode',
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'x-admin-key': ADMIN_KEY }
  }, { mode: 'ALERT' });

  // Lấy token cho ACC030, ACC031, ACC032
  const token30 = await loginAccount('ACC030');
  const token31 = await loginAccount('ACC031');
  const token32 = await loginAccount('ACC032');

  // GD 1: ACC030 -> ACC031
  const tx1 = await request({
    hostname: 'localhost',
    port: 3000,
    path: '/api/transactions',
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token30}` }
  }, { fromAccountId: 'ACC030', toAccountId: 'ACC031', amount: 5000000, note: 'Round 1' });
  console.log(`GD1 (30->31): HTTP ${tx1.status}`);

  // GD 2: ACC031 -> ACC032
  const tx2 = await request({
    hostname: 'localhost',
    port: 3000,
    path: '/api/transactions',
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token31}` }
  }, { fromAccountId: 'ACC031', toAccountId: 'ACC032', amount: 5000000, note: 'Round 2' });
  console.log(`GD2 (31->32): HTTP ${tx2.status}`);

  // GD 3: ACC032 -> ACC030 (Khép chu trình)
  const tx3 = await request({
    hostname: 'localhost',
    port: 3000,
    path: '/api/transactions',
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token32}` }
  }, { fromAccountId: 'ACC032', toAccountId: 'ACC030', amount: 5000000, note: 'Round 3 closes cycle' });
  console.log(`GD3 (32->30): HTTP ${tx3.status} - fraudAlert: ${tx3.body.fraudAlert}`);

  // Kiểm tra xem cả 3 tài khoản có bị đóng băng với reason CYCLE không
  const frozenListB = await request({
    hostname: 'localhost',
    port: 3000,
    path: '/api/security/frozen',
    method: 'GET',
    headers: { 'x-admin-key': ADMIN_KEY }
  });
  const frozenMapB = {};
  for (const f of frozenListB.body.frozenAccounts || []) {
    frozenMapB[f.accountId] = f;
  }
  console.log('Danh sách tài khoản đóng băng sau chu trình:', frozenMapB);

  const is30Frozen = frozenMapB['ACC030'] && frozenMapB['ACC030'].reason === 'CYCLE';
  const is31Frozen = frozenMapB['ACC031'] && frozenMapB['ACC031'].reason === 'CYCLE';
  const is32Frozen = frozenMapB['ACC032'] && frozenMapB['ACC032'].reason === 'CYCLE';

  if (tx3.status === 201 && tx3.body.fraudAlert && is30Frozen && is31Frozen && is32Frozen) {
    testPassed.b = true;
    console.log('==> TEST (B) PASS!\n');
  } else {
    console.log('==> TEST (B) FAIL!\n');
  }

  // ==========================================
  // TEST (C): IN BLOCK MODE, GD KHÉP VÒNG BỊ CHẶN (HTTP 409) VÀ SỐ DƯ GIỮ NGUYÊN
  // ==========================================
  console.log('--- TEST (C): Chế độ BLOCK: Chặn GD khép vòng với HTTP 409 và giữ nguyên số dư ---');
  // Chuyển sang chế độ BLOCK
  await request({
    hostname: 'localhost',
    port: 3000,
    path: '/api/security/mode',
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'x-admin-key': ADMIN_KEY }
  }, { mode: 'BLOCK' });

  // Dùng 3 tài khoản khác chưa bị đóng băng: ACC035 -> ACC036 -> ACC037 -> ACC035
  const token35 = await loginAccount('ACC035');
  const token36 = await loginAccount('ACC036');
  const token37 = await loginAccount('ACC037');

  // Bước 1: 35 -> 36 (thành công)
  const blockTx1 = await request({
    hostname: 'localhost',
    port: 3000,
    path: '/api/transactions',
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token35}` }
  }, { fromAccountId: 'ACC035', toAccountId: 'ACC036', amount: 3000000, note: 'Step 1' });
  console.log(`GD1 (35->36): HTTP ${blockTx1.status}`);

  // Bước 2: 36 -> 37 (thành công)
  const blockTx2 = await request({
    hostname: 'localhost',
    port: 3000,
    path: '/api/transactions',
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token36}` }
  }, { fromAccountId: 'ACC036', toAccountId: 'ACC037', amount: 3000000, note: 'Step 2' });
  console.log(`GD2 (36->37): HTTP ${blockTx2.status}`);

  // Lấy số dư của ACC037 (nguồn) và ACC035 (đích) NGAY TRƯỚC BƯỚC 3 (bước khép chu trình)
  const acc37Before = await request({ hostname: 'localhost', port: 3000, path: '/api/accounts/ACC037', method: 'GET' });
  const acc35Before = await request({ hostname: 'localhost', port: 3000, path: '/api/accounts/ACC035', method: 'GET' });
  const bal37Before = acc37Before.body.balance;
  const bal35Before = acc35Before.body.balance;

  // Bước 3: 37 -> 35 (Sẽ khép chu trình 35->36->37->35 -> PHẢI BỊ CHẶN HTTP 409)
  const blockTx3 = await request({
    hostname: 'localhost',
    port: 3000,
    path: '/api/transactions',
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token37}` }
  }, { fromAccountId: 'ACC037', toAccountId: 'ACC035', amount: 3000000, note: 'Step 3 closing cycle' });
  console.log(`GD3 (37->35) in BLOCK mode: HTTP ${blockTx3.status} - Body:`, JSON.stringify(blockTx3.body));

  // Kiểm tra số dư sau khi bị chặn
  const acc37After = await request({ hostname: 'localhost', port: 3000, path: '/api/accounts/ACC037', method: 'GET' });
  const acc35After = await request({ hostname: 'localhost', port: 3000, path: '/api/accounts/ACC035', method: 'GET' });
  const bal37After = acc37After.body.balance;
  const bal35After = acc35After.body.balance;

  console.log(`ACC037 Balance: Trước = ${bal37Before}, Sau = ${bal37After}`);
  console.log(`ACC035 Balance: Trước = ${bal35Before}, Sau = ${bal35After}`);

  const balancesUntouched = (bal37Before === bal37After && bal35Before === bal35After);

  if (blockTx3.status === 409 && blockTx3.body.blocked === true && balancesUntouched) {
    testPassed.c = true;
    console.log('==> TEST (C) PASS!\n');
  } else {
    console.log('==> TEST (C) FAIL!\n');
  }

  // ==========================================
  // TEST (D): GET /api/risk/scores
  // ==========================================
  console.log('--- TEST (D): GET /api/risk/scores trả 50 phần tử, điểm [0, 100], ACC001 hợp lý ---');
  const riskRes = await request({
    hostname: 'localhost',
    port: 3000,
    path: '/api/risk/scores',
    method: 'GET',
    headers: { 'x-admin-key': ADMIN_KEY }
  });

  const scores = riskRes.body;
  const isArray50 = Array.isArray(scores) && scores.length === 50;
  console.log(`Số phần tử trả về: ${Array.isArray(scores) ? scores.length : 'Không phải Array'}`);

  let allInRange = true;
  for (const s of scores) {
    if (typeof s.score !== 'number' || s.score < 0 || s.score > 100 || !['LOW', 'MEDIUM', 'HIGH'].includes(s.level)) {
      allInRange = false;
      break;
    }
  }

  const acc001Score = (scores || []).find(s => s.accountId === 'ACC001');
  console.log('ACC001 Risk Score:', JSON.stringify(acc001Score));
  const acc001Valid = acc001Score && acc001Score.factors.inCycle === true && acc001Score.score >= 40;

  if (isArray50 && allInRange && acc001Valid) {
    testPassed.d = true;
    console.log('==> TEST (D) PASS!\n');
  } else {
    console.log('==> TEST (D) FAIL!\n');
  }

  console.log('========================================================');
  console.log('KẾT QUẢ TỔNG HỢP KIỂM THỬ:');
  console.log(`Test (A) Brute-Force Freezing (423):  ${testPassed.a ? 'PASS ✅' : 'FAIL ❌'}`);
  console.log(`Test (B) Cycle Freezing ALERT (3 Acc): ${testPassed.b ? 'PASS ✅' : 'FAIL ❌'}`);
  console.log(`Test (C) Cycle Prevention BLOCK (409): ${testPassed.c ? 'PASS ✅' : 'FAIL ❌'}`);
  console.log(`Test (D) Risk Scores Matrix (50 Acc):  ${testPassed.d ? 'PASS ✅' : 'FAIL ❌'}`);
  console.log('========================================================');

  const allPassed = Object.values(testPassed).every(Boolean);
  process.exit(allPassed ? 0 : 1);
}

runTests().catch(err => {
  console.error('Lỗi kiểm thử:', err);
  process.exit(1);
});
