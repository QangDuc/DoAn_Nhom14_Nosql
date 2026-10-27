const http = require('http');

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

async function runVerification() {
  console.log('========================================================');
  console.log('BẮT ĐẦU KIỂM CHUẨN TÍNH NĂNG PHÂN TÍCH SÂU (ADVANCED CYPHER)');
  console.log('========================================================\n');

  let results = {
    a: false,
    b: false,
    c: false,
    d: false,
    e: false,
    f: false
  };

  // 0. Reset dữ liệu ban đầu
  console.log('0. Reset dữ liệu về trạng thái mẫu ban đầu...');
  const resetRes = await request({
    hostname: 'localhost',
    port: 3000,
    path: '/api/admin/seed-reset',
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-admin-key': ADMIN_KEY }
  });
  console.log(`Reset status: ${resetRes.status}\n`);

  // (a) /cycles/long?minLen=3&maxLen=3 cho số chu trình bằng cycleCount của /api/fraud/cycles
  console.log('--- TEST (a): /cycles/long?minLen=3&maxLen=3 khớp cycleCount của /api/fraud/cycles ---');
  const baseCyclesRes = await request({
    hostname: 'localhost',
    port: 3000,
    path: '/api/fraud/cycles',
    method: 'GET'
  });
  const expectedCycleCount = baseCyclesRes.body.summary.cycleCount;
  console.log(`cycleCount hiện tại từ /api/fraud/cycles: ${expectedCycleCount}`);

  const t0 = Date.now();
  const longCyclesRes = await request({
    hostname: 'localhost',
    port: 3000,
    path: '/api/fraud/cycles/long?minLen=3&maxLen=3',
    method: 'GET',
    headers: { 'x-admin-key': ADMIN_KEY, 'x-allow-fallback': 'true' }
  });
  const tDurationA = Date.now() - t0;
  console.log(`Kết quả /cycles/long?minLen=3&maxLen=3: HTTP ${longCyclesRes.status}, count = ${longCyclesRes.body.count}, time = ${tDurationA}ms`);
  console.log(`Chu trình tìm được:`, (longCyclesRes.body.cycles || []).map(c => c.path));

  if (longCyclesRes.status === 200 && longCyclesRes.body.count === expectedCycleCount) {
    results.a = true;
    console.log('==> TEST (a) PASS ✅\n');
  } else {
    console.log('==> TEST (a) FAIL ❌\n');
  }

  // (b) thêm tay chu trình 4 đỉnh ACC040→041→042→043→040, minLen=4&maxLen=4 phát hiện đúng 1
  console.log('--- TEST (b): Thêm chu trình 4 đỉnh ACC040 -> 041 -> 042 -> 043 -> 040, minLen=4&maxLen=4 ---');
  // Lấy token đăng nhập
  const tok40 = await loginAccount('ACC040');
  const tok41 = await loginAccount('ACC041');
  const tok42 = await loginAccount('ACC042');
  const tok43 = await loginAccount('ACC043');

  // Chuyển tiền tạo vòng 4 đỉnh
  await request({
    hostname: 'localhost',
    port: 3000,
    path: '/api/transactions',
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${tok40}` }
  }, { fromAccountId: 'ACC040', toAccountId: 'ACC041', amount: 1000000, note: 'Cycle4 step 1' });

  await request({
    hostname: 'localhost',
    port: 3000,
    path: '/api/transactions',
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${tok41}` }
  }, { fromAccountId: 'ACC041', toAccountId: 'ACC042', amount: 1000000, note: 'Cycle4 step 2' });

  await request({
    hostname: 'localhost',
    port: 3000,
    path: '/api/transactions',
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${tok42}` }
  }, { fromAccountId: 'ACC042', toAccountId: 'ACC043', amount: 1000000, note: 'Cycle4 step 3' });

  await request({
    hostname: 'localhost',
    port: 3000,
    path: '/api/transactions',
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${tok43}` }
  }, { fromAccountId: 'ACC043', toAccountId: 'ACC040', amount: 1000000, note: 'Cycle4 step 4 close' });

  const fourCyclesRes = await request({
    hostname: 'localhost',
    port: 3000,
    path: '/api/fraud/cycles/long?minLen=4&maxLen=4',
    method: 'GET',
    headers: { 'x-admin-key': ADMIN_KEY, 'x-allow-fallback': 'true' }
  });
  console.log(`Kết quả minLen=4&maxLen=4: HTTP ${fourCyclesRes.status}, count = ${fourCyclesRes.body.count}`);
  console.log(`Chu trình 4 đỉnh:`, (fourCyclesRes.body.cycles || []).map(c => c.path));

  const foundCycle4 = (fourCyclesRes.body.cycles || []).some(c => 
    c.path.includes('ACC040') && c.path.includes('ACC041') && c.path.includes('ACC042') && c.path.includes('ACC043') && c.length === 4
  );

  if (fourCyclesRes.status === 200 && fourCyclesRes.body.count === 1 && foundCycle4) {
    results.b = true;
    console.log('==> TEST (b) PASS ✅\n');
  } else {
    console.log('==> TEST (b) FAIL ❌\n');
  }

  // (c) maxLen=6 trả 400
  console.log('--- TEST (c): maxLen=6 trả HTTP 400 ---');
  const invalidRes = await request({
    hostname: 'localhost',
    port: 3000,
    path: '/api/fraud/cycles/long?maxLen=6',
    method: 'GET',
    headers: { 'x-admin-key': ADMIN_KEY, 'x-allow-fallback': 'true' }
  });
  console.log(`Kết quả maxLen=6: HTTP ${invalidRes.status} - Body:`, JSON.stringify(invalidRes.body));

  if (invalidRes.status === 400 && invalidRes.body.error) {
    results.c = true;
    console.log('==> TEST (c) PASS ✅\n');
  } else {
    console.log('==> TEST (c) FAIL ❌\n');
  }

  // (d) sau seed-patterns mỗi type trả >= 1 item, /api/fraud/cycles vẫn cycleCount = 3
  console.log('--- TEST (d): Sau seed-patterns mỗi type trả >= 1 item, /api/fraud/cycles cycleCount = 3 ---');
  // Trước hết reset lại để xóa chu trình 4 đỉnh vừa tạo ở test b
  await request({
    hostname: 'localhost',
    port: 3000,
    path: '/api/admin/seed-reset',
    method: 'POST',
    headers: { 'x-admin-key': ADMIN_KEY }
  });

  // Gọi seed-patterns
  const seedPatRes = await request({
    hostname: 'localhost',
    port: 3000,
    path: '/api/admin/seed-patterns',
    method: 'POST',
    headers: { 'x-admin-key': ADMIN_KEY }
  });
  console.log(`seed-patterns status: HTTP ${seedPatRes.status}, inserted: ${seedPatRes.body.insertedCount}`);

  // Kiểm tra 3 type
  const structRes = await request({
    hostname: 'localhost',
    port: 3000,
    path: '/api/fraud/patterns?type=structuring',
    method: 'GET',
    headers: { 'x-admin-key': ADMIN_KEY, 'x-allow-fallback': 'true' }
  });
  console.log(`Pattern Structuring: count = ${structRes.body.count}`);

  const passRes = await request({
    hostname: 'localhost',
    port: 3000,
    path: '/api/fraud/patterns?type=passthrough',
    method: 'GET',
    headers: { 'x-admin-key': ADMIN_KEY, 'x-allow-fallback': 'true' }
  });
  console.log(`Pattern Passthrough: count = ${passRes.body.count}`);

  const fanoutRes = await request({
    hostname: 'localhost',
    port: 3000,
    path: '/api/fraud/patterns?type=fanout',
    method: 'GET',
    headers: { 'x-admin-key': ADMIN_KEY, 'x-allow-fallback': 'true' }
  });
  console.log(`Pattern Fanout: count = ${fanoutRes.body.count}`);

  // Kiểm tra lại /api/fraud/cycles: KHÔNG ĐƯỢC TĂNG, PHẢI VẪN LÀ 3!
  const checkCyclesRes = await request({
    hostname: 'localhost',
    port: 3000,
    path: '/api/fraud/cycles',
    method: 'GET'
  });
  const cycleCountAfterSeed = checkCyclesRes.body.summary.cycleCount;
  console.log(`cycleCount sau seed-patterns: ${cycleCountAfterSeed} (Mong đợi: 3)`);

  const patternsValid = (structRes.body.count >= 1) && (passRes.body.count >= 1) && (fanoutRes.body.count >= 1);
  if (patternsValid && cycleCountAfterSeed === 3) {
    results.d = true;
    console.log('==> TEST (d) PASS ✅\n');
  } else {
    console.log('==> TEST (d) FAIL ❌\n');
  }

  // (e) seed-reset đưa về đúng 50 Account, 114 giao dịch
  console.log('--- TEST (e): seed-reset đưa về đúng 50 Account, 114 giao dịch ---');
  const finalReset = await request({
    hostname: 'localhost',
    port: 3000,
    path: '/api/admin/seed-reset',
    method: 'POST',
    headers: { 'x-admin-key': ADMIN_KEY }
  });
  console.log('seed-reset summary:', JSON.stringify(finalReset.body.summary));

  const accsRes = await request({ hostname: 'localhost', port: 3000, path: '/api/accounts', method: 'GET' });
  const txsRes = await request({ hostname: 'localhost', port: 3000, path: '/api/transactions?limit=200', method: 'GET' });
  const accCount = accsRes.body.accounts.length;
  const txCount = txsRes.body.count;

  console.log(`Số Account: ${accCount} (Mong đợi 50), Số Transaction: ${txCount} (Mong đợi 114)`);
  if (accCount === 50 && txCount === 114) {
    results.e = true;
    console.log('==> TEST (e) PASS ✅\n');
  } else {
    console.log('==> TEST (e) FAIL ❌\n');
  }

  // (f) không có truy vấn nào vượt 5s trên dữ liệu seed
  console.log('--- TEST (f): Đo thời gian thực thi các truy vấn phân tích (yêu cầu < 5s) ---');
  const tStartLong = Date.now();
  await request({
    hostname: 'localhost',
    port: 3000,
    path: '/api/fraud/cycles/long?minLen=3&maxLen=5',
    method: 'GET',
    headers: { 'x-admin-key': ADMIN_KEY, 'x-allow-fallback': 'true' }
  });
  const tLong = Date.now() - tStartLong;

  const tStartStruct = Date.now();
  await request({
    hostname: 'localhost',
    port: 3000,
    path: '/api/fraud/patterns?type=structuring',
    method: 'GET',
    headers: { 'x-admin-key': ADMIN_KEY, 'x-allow-fallback': 'true' }
  });
  const tStruct = Date.now() - tStartStruct;

  const tStartPass = Date.now();
  await request({
    hostname: 'localhost',
    port: 3000,
    path: '/api/fraud/patterns?type=passthrough',
    method: 'GET',
    headers: { 'x-admin-key': ADMIN_KEY, 'x-allow-fallback': 'true' }
  });
  const tPass = Date.now() - tStartPass;

  const tStartFan = Date.now();
  await request({
    hostname: 'localhost',
    port: 3000,
    path: '/api/fraud/patterns?type=fanout',
    method: 'GET',
    headers: { 'x-admin-key': ADMIN_KEY, 'x-allow-fallback': 'true' }
  });
  const tFan = Date.now() - tStartFan;

  console.log(`Thời gian chạy: LongCycles: ${tLong}ms, Structuring: ${tStruct}ms, Passthrough: ${tPass}ms, Fanout: ${tFan}ms`);
  if (tLong < 5000 && tStruct < 5000 && tPass < 5000 && tFan < 5000) {
    results.f = true;
    console.log('==> TEST (f) PASS ✅\n');
  } else {
    console.log('==> TEST (f) FAIL ❌\n');
  }

  console.log('========================================================');
  console.log('KẾT QUẢ TỔNG HỢP KIỂM CHUẨN 6 TIÊU CHÍ (a)-(f):');
  console.log(`(a) Long cycles 3..3 count == base cycleCount: ${results.a ? 'PASS ✅' : 'FAIL ❌'}`);
  console.log(`(b) Detect manual 4-vertex cycle:               ${results.b ? 'PASS ✅' : 'FAIL ❌'}`);
  console.log(`(c) maxLen=6 returns HTTP 400:                 ${results.c ? 'PASS ✅' : 'FAIL ❌'}`);
  console.log(`(d) seed-patterns >=1 per type & cycles == 3:  ${results.d ? 'PASS ✅' : 'FAIL ❌'}`);
  console.log(`(e) seed-reset restores 50 acc & 114 txs:      ${results.e ? 'PASS ✅' : 'FAIL ❌'}`);
  console.log(`(f) All queries complete under 5000ms:         ${results.f ? 'PASS ✅' : 'FAIL ❌'}`);
  console.log('========================================================');

  const allPassed = Object.values(results).every(Boolean);
  process.exit(allPassed ? 0 : 1);
}

runVerification().catch(err => {
  console.error('Lỗi kiểm chuẩn:', err);
  process.exit(1);
});

