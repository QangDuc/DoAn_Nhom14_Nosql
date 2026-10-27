const http = require('http');

function post(path, body = {}, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({
      hostname: 'localhost',
      port: 3000,
      path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        ...headers
      }
    }, (res) => {
      let d = '';
      res.on('data', c => { d += c; });
      res.on('end', () => {
        resolve({ status: res.statusCode, body: JSON.parse(d || '{}') });
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function get(path, headers = {}) {
  return new Promise((resolve, reject) => {
    http.get({ hostname: 'localhost', port: 3000, path, headers }, (res) => {
      let d = '';
      res.on('data', c => { d += c; });
      res.on('end', () => {
        resolve({ status: res.statusCode, body: JSON.parse(d || '{}') });
      });
    }).on('error', reject);
  });
}

async function runDemo() {
  console.log('================================================================');
  console.log('🚀 BẮT ĐẦU CHẠY THỬ KỊCH BẢN DEMO TOÀN DIỆN CHO HỘI ĐỒNG');
  console.log('================================================================\n');

  // 1. Kiểm tra trạng thái hệ thống
  const health = await get('/api/health');
  console.log(`[Trạng thái CSDL] Neo4j: ${health.body.neo4j} | Redis: ${health.body.redis}`);

  // 2. Đăng nhập Quản trị viên (Staff ADMIN) & Reset dữ liệu gốc
  const staffPass = process.env.STAFF_DEMO_PASSWORD || 'NhanVien@123';
  const adminLogin = await post('/api/staff/login', { staffId: 'STAFF001', password: staffPass });
  const adminToken = adminLogin.body.token;

  const reset = await post('/api/admin/seed-reset', {}, { 'Authorization': 'Bearer ' + adminToken });
  console.log(`\n[Khởi tạo Demo] ${reset.body.message}`);

  // 3. KỊCH BẢN 1: Tấn công Brute-force 5 lần vào ACC025
  console.log('\n----------------------------------------------------------------');
  console.log('🛡️ KỊCH BẢN 1: TẤN CÔNG BRUTE-FORCE 5 LẦN VÀO TÀI KHOẢN ACC025');
  console.log('----------------------------------------------------------------');
  for (let i = 1; i <= 5; i++) {
    const res = await post('/api/auth/login', { accountId: 'ACC025', password: 'WrongPassword_' + i });
    console.log(`Lần ${i} -> HTTP ${res.status}: ${res.body.error}`);
  }

  // Thử đăng nhập lại bằng mật khẩu đúng khi đang bị khóa
  const lockCheck = await post('/api/auth/login', { accountId: 'ACC025', password: 'MatKhau@123' });
  console.log(`\nThử MK đúng khi bị khóa -> HTTP ${lockCheck.status}: ${lockCheck.body.error} (Còn lại: ${lockCheck.body.remainingSeconds}s)`);

  // 4. KỊCH BẢN 2: Chuyển tiền & Tạo chu trình rửa tiền ACC030 -> ACC031 -> ACC032 -> ACC030
  console.log('\n----------------------------------------------------------------');
  console.log('💸 KỊCH BẢN 2: THỰC THI GIAO DỊCH VÀ KHÉP VÒNG RỬA TIỀN');
  console.log('----------------------------------------------------------------');

  const l30 = await post('/api/auth/login', { accountId: 'ACC030', password: 'MatKhau@123' });
  const l31 = await post('/api/auth/login', { accountId: 'ACC031', password: 'MatKhau@123' });
  const l32 = await post('/api/auth/login', { accountId: 'ACC032', password: 'MatKhau@123' });

  // Bước 1: ACC030 -> ACC031 (45.000.000 VNĐ)
  const tx1 = await post('/api/transactions', {
    fromAccountId: 'ACC030', toAccountId: 'ACC031', amount: 45000000, note: 'Chuyển vốn đợt 1'
  }, { 'Authorization': 'Bearer ' + l30.body.token });
  console.log(`Bước 1 (ACC030 -> ACC031): HTTP ${tx1.status} | fraudAlert = ${tx1.body.fraudAlert}`);

  // Bước 2: ACC031 -> ACC032 (44.500.000 VNĐ)
  const tx2 = await post('/api/transactions', {
    fromAccountId: 'ACC031', toAccountId: 'ACC032', amount: 44500000, note: 'Hợp đồng dịch vụ'
  }, { 'Authorization': 'Bearer ' + l31.body.token });
  console.log(`Bước 2 (ACC031 -> ACC032): HTTP ${tx2.status} | fraudAlert = ${tx2.body.fraudAlert}`);

  // Bước 3: ACC032 -> ACC030 (44.000.000 VNĐ - Khép vòng)
  const tx3 = await post('/api/transactions', {
    fromAccountId: 'ACC032', toAccountId: 'ACC030', amount: 44000000, note: 'Hoàn trả ủy thác (Khép vòng)'
  }, { 'Authorization': 'Bearer ' + l32.body.token });
  console.log(`Bước 3 (ACC032 -> ACC030): HTTP ${tx3.status} | fraudAlert = ${tx3.body.fraudAlert}`);
  if (tx3.body.detectedCycles && tx3.body.detectedCycles.length > 0) {
    console.log(`   🚨 Cảnh báo chu trình: ${tx3.body.detectedCycles[0].cyclePath}`);
  }

  // 5. KỊCH BẢN 3: Quét lại toàn bộ chu trình gian lận trên hệ thống
  console.log('\n----------------------------------------------------------------');
  console.log('🕸️ KỊCH BẢN 3: KẾT QUẢ QUÉT CHU TRÌNH RỬA TIỀN TRÊN ĐỒ THỊ');
  console.log('----------------------------------------------------------------');
  const fraud = await get('/api/fraud/cycles');
  console.log(`Tổng số chu trình phát hiện: ${fraud.body.summary.cycleCount} (Tài khoản liên quan: ${fraud.body.summary.fraudAccountCount})`);
  fraud.body.cycles.forEach((c, idx) => {
    console.log(` #${idx + 1}: ${c.path} | Tổng tiền: ${Number(c.totalAmount).toLocaleString('vi-VN')} đ | TG: ${c.durationText}`);
  });

  console.log('\n================================================================');
  console.log('✅ DEMO ĐÃ CHẠY HOÀN TẤT! GIAO DIỆN SẴN SÀNG TẠI: http://localhost:3000');
  console.log('================================================================');
}

runDemo().catch(console.error);

