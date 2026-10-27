const http = require('http');
const ADMIN_KEY = 'admin_secret_key_123';

function request(method, path, body = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: 'localhost',
      port: 3000,
      path,
      method,
      headers: {
        'Content-Type': 'application/json',
        ...headers
      }
    };

    const req = http.request(opts, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(data) });
        } catch (_) {
          resolve({ status: res.statusCode, data });
        }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function verify() {
  console.log('=== START VERIFICATION ===\n');

  // 1. Reset / Seed
  const resetRes = await request('POST', '/api/admin/seed-reset', null, { 'x-admin-key': 'admin_secret_key_123' });
  console.log('Seed reset status:', resetRes.status);

  // (a) Sau seed, GET /api/fraud/cycles cho cycleCount = 3
  const cycles1 = await request('GET', '/api/fraud/cycles');
  const count1 = cycles1.data.summary.cycleCount;
  const passA = count1 === 3;
  console.log(`(a) cycleCount after seed: ${count1} (Expected 3) -> ${passA ? 'PASS' : 'FAIL'}`);

  // (d) Redis có >= 10 key login:* sau seed
  const secStatus1 = await request('GET', '/api/auth/admin/security-status', null, { 'x-admin-key': 'admin_secret_key_123' });
  const keyCount = secStatus1.data.summary ? secStatus1.data.summary.monitored : secStatus1.data.totalMonitored;
  const passD = keyCount >= 10;
  console.log(`(d) Redis keys count after seed: ${keyCount} (Expected >= 10) -> ${passD ? 'PASS' : 'FAIL'}`);

  // (c) security-status trả status đúng ("LOCKED", "WARNING", "NORMAL") và summary {monitored, locked, warning}
  const summary = secStatus1.data.summary;
  const items = secStatus1.data.items;
  const hasLocked = items.some(i => i.status === 'LOCKED' && i.isLocked);
  const hasWarning = items.some(i => i.status === 'WARNING' && !i.isLocked && i.failCount >= 3);
  const hasNormal = items.some(i => i.status === 'NORMAL' && !i.isLocked && i.failCount < 3);
  const passC = summary && typeof summary.monitored === 'number' && typeof summary.locked === 'number' && typeof summary.warning === 'number'
    && hasLocked && hasWarning && hasNormal;
  console.log(`(c) security-status structure and statuses: summary=${JSON.stringify(summary)}, hasLocked=${hasLocked}, hasWarning=${hasWarning}, hasNormal=${hasNormal} -> ${passC ? 'PASS' : 'FAIL'}`);

  // (b) Tạo 3 giao dịch ACC030->031->032->030 lặp lại 2 lần (tổng 6 giao dịch)
  // Trước hết lấy token cho ACC030, ACC031, ACC032
  const login = async (acc) => {
    const r = await request('POST', '/api/auth/login', { accountId: acc, password: 'MatKhau@123' });
    return r.data.token;
  };

  const tok30 = await login('ACC030');
  const tok31 = await login('ACC031');
  const tok32 = await login('ACC032');

  console.log('\nTạo vòng 1: ACC030 -> ACC031 -> ACC032 -> ACC030...');
  const tx1a = await request('POST', '/api/transactions', { fromAccountId: 'ACC030', toAccountId: 'ACC031', amount: 45000000, note: 'Round 1 A' }, { Authorization: `Bearer ${tok30}` });
  const tx1b = await request('POST', '/api/transactions', { fromAccountId: 'ACC031', toAccountId: 'ACC032', amount: 44500000, note: 'Round 1 B' }, { Authorization: `Bearer ${tok31}` });
  const tx1c = await request('POST', '/api/transactions', { fromAccountId: 'ACC032', toAccountId: 'ACC030', amount: 44000000, note: 'Round 1 C' }, { Authorization: `Bearer ${tok32}` });
  console.log('Round 1 closure detectedCycles:', tx1c.data.transaction ? 'OK' : 'ERR', 'Detected:', tx1c.data.transaction ? tx1c.data.message : '');

  // Mở đóng băng 3 tài khoản vừa bị đóng băng do tạo chu trình để tiếp tục kiểm thử vòng 2
  await request('POST', '/api/security/unfreeze/ACC030', {}, { 'x-admin-key': ADMIN_KEY });
  await request('POST', '/api/security/unfreeze/ACC031', {}, { 'x-admin-key': ADMIN_KEY });
  await request('POST', '/api/security/unfreeze/ACC032', {}, { 'x-admin-key': ADMIN_KEY });

  console.log('Tạo vòng 2: ACC030 -> ACC031 -> ACC032 -> ACC030 (cạnh song song)...');
  const tx2a = await request('POST', '/api/transactions', { fromAccountId: 'ACC030', toAccountId: 'ACC031', amount: 43000000, note: 'Round 2 A' }, { Authorization: `Bearer ${tok30}` });
  console.log('tx2a status:', tx2a.status, tx2a.data.error || 'OK');

  await request('POST', '/api/security/unfreeze/ACC030', {}, { 'x-admin-key': ADMIN_KEY });
  await request('POST', '/api/security/unfreeze/ACC031', {}, { 'x-admin-key': ADMIN_KEY });
  await request('POST', '/api/security/unfreeze/ACC032', {}, { 'x-admin-key': ADMIN_KEY });

  const tx2b = await request('POST', '/api/transactions', { fromAccountId: 'ACC031', toAccountId: 'ACC032', amount: 42500000, note: 'Round 2 B' }, { Authorization: `Bearer ${tok31}` });
  console.log('tx2b status:', tx2b.status, tx2b.data.error || 'OK');

  // Mở đóng băng nếu cạnh song song vừa kích hoạt cycle alert
  await request('POST', '/api/security/unfreeze/ACC030', {}, { 'x-admin-key': ADMIN_KEY });
  await request('POST', '/api/security/unfreeze/ACC031', {}, { 'x-admin-key': ADMIN_KEY });
  await request('POST', '/api/security/unfreeze/ACC032', {}, { 'x-admin-key': ADMIN_KEY });

  const tx2c = await request('POST', '/api/transactions', { fromAccountId: 'ACC032', toAccountId: 'ACC030', amount: 42000000, note: 'Round 2 C' }, { Authorization: `Bearer ${tok32}` });
  console.log('Round 2 closure detectedCycles:', tx2c.data.transaction ? 'OK' : 'ERR', 'Status:', tx2c.status, 'Error:', tx2c.data.error || '', 'Detected:', tx2c.data.transaction ? tx2c.data.message : '');

  const cycles2 = await request('GET', '/api/fraud/cycles');
  const count2 = cycles2.data.summary.cycleCount;
  const cycle4 = cycles2.data.cycles.find(c => c.accounts.some(a => a.accountId === 'ACC030'));
  const txIdsCount = cycle4 ? cycle4.txIds.length : 0;
  const passB = count2 === 4 && txIdsCount === 6;

  console.log(`(b) cycleCount after 2 parallel rounds: ${count2} (Expected 4)`);
  console.log(`    cycle 4 txIds count: ${txIdsCount} (Expected 6) -> ${passB ? 'PASS' : 'FAIL'}`);

  console.log('\n=== SUMMARY ===');
  console.log('Requirement (a):', passA ? 'PASS' : 'FAIL');
  console.log('Requirement (b):', passB ? 'PASS' : 'FAIL');
  console.log('Requirement (c):', passC ? 'PASS' : 'FAIL');
  console.log('Requirement (d):', passD ? 'PASS' : 'FAIL');
}

verify().catch(console.error);

