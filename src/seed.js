require('dotenv').config();
const bcrypt = require('bcryptjs');
const { driver, initNeo4jSchema } = require('./config/neo4j');
const redis = require('./config/redis');

// Danh sách họ tên tiếng Việt tự nhiên để tạo đúng 50 tài khoản
const FIRST_NAMES = ['Nguyễn', 'Trần', 'Lê', 'Phạm', 'Hoàng', 'Huỳnh', 'Phan', 'Vũ', 'Võ', 'Đặng'];
const MIDDLE_NAMES = ['Văn', 'Thị', 'Minh', 'Hữu', 'Đức', 'Ngọc', 'Quốc', 'Thanh', 'Gia', 'Bảo'];
const LAST_NAMES = ['An', 'Bình', 'Cường', 'Dũng', 'Giang', 'Hải', 'Khánh', 'Linh', 'Nam', 'Phúc'];

const DEMO_PASSWORD_PLAIN = 'MatKhau@123';

/**
 * Hàm chạy seed dữ liệu mẫu cho cả Neo4j và Redis (có thể gọi từ CLI hoặc từ API Reset trên Dashboard)
 */
async function seedAllData() {
  const session = driver.session();
  try {
    console.log('==========================================================');
    console.log('BẮT ĐẦU KHỞI TẠO / RESET DỮ LIỆU MẪU (NEO4J + REDIS)');
    console.log('==========================================================');

    // 1. Khởi tạo Constraint & Index trên Neo4j
    await initNeo4jSchema();

    // 2. Xóa dữ liệu cũ trong Neo4j và Redis (chỉ xóa các key tiền tố của dự án: login:, session:, otp:, config:)
    await session.run(`MATCH (n) DETACH DELETE n`);
    const seedPrefixes = ['login:*', 'session:*', 'otp:*', 'config:*'];
    for (const prefix of seedPrefixes) {
      let cursor = '0';
      do {
        const res = await redis.scan(cursor, 'MATCH', prefix, 'COUNT', 100);
        cursor = res[0];
        const keys = res[1];
        if (keys && keys.length > 0) {
          if (typeof redis.unlink === 'function') {
            await redis.unlink(...keys);
          } else {
            await redis.del(...keys);
          }
        }
      } while (cursor !== '0');
    }
    console.log('[Reset] Đã xóa sạch dữ liệu cũ trên Neo4j và các key tiền tố (login, session, otp, config) trên Redis.');

    // 3. Băm mật khẩu demo bằng bcrypt
    const passwordHash = await bcrypt.hash(DEMO_PASSWORD_PLAIN, 10);

    // 3.1. Băm mật khẩu Quản trị viên từ biến môi trường ADMIN_DEMO_PASSWORD (KHÔNG ghi mật khẩu trong code)
    const adminPasswordPlain = process.env.ADMIN_DEMO_PASSWORD;
    if (!adminPasswordPlain) {
      throw new Error('Biến môi trường ADMIN_DEMO_PASSWORD chưa được thiết lập!');
    }
    const adminPasswordHash = await bcrypt.hash(adminPasswordPlain, 10);

    // 3.2. Băm mật khẩu nhân viên từ biến môi trường STAFF_DEMO_PASSWORD (KHÔNG ghi mật khẩu trong code)
    const staffPasswordPlain = process.env.STAFF_DEMO_PASSWORD;
    if (!staffPasswordPlain) {
      throw new Error('Biến môi trường STAFF_DEMO_PASSWORD chưa được thiết lập!');
    }
    const staffPasswordHash = await bcrypt.hash(staffPasswordPlain, 10);

    // 4. Tạo đúng 50 tài khoản: ACC001 -> ACC050 với balance ban đầu
    const now = Date.now();
    const thirtyDaysMs = 30 * 24 * 3600 * 1000;
    const initialAccounts = new Map();

    for (let i = 1; i <= 50; i++) {
      const accountId = `ACC${String(i).padStart(3, '0')}`;
      const fName = FIRST_NAMES[(i - 1) % FIRST_NAMES.length];
      const mName = MIDDLE_NAMES[Math.floor((i - 1) / 5) % MIDDLE_NAMES.length];
      const lName = LAST_NAMES[(i * 3) % LAST_NAMES.length];
      const ownerName = `${fName} ${mName} ${lName}`;
      // Số dư khởi tạo từ 100 triệu đến 500 triệu VNĐ để đảm bảo không bị âm sau khi trừ giao dịch
      const balance = (100 + (i * 8)) * 1000000;
      const createdAt = now - thirtyDaysMs - (50 - i) * 3600000;
      const role = (i === 1) ? 'ADMIN' : 'CUSTOMER';
      const accPasswordHash = (i === 1) ? adminPasswordHash : passwordHash;

      initialAccounts.set(accountId, {
        accountId,
        ownerName,
        passwordHash: accPasswordHash,
        balance,
        status: 'ACTIVE',
        role,
        createdAt
      });
    }

    // 5. Tạo các giao dịch TRANSFERRED
    // Thiết kế 3 chu trình rửa tiền A -> B -> C -> A cố định trên tập đỉnh riêng biệt (ACC001..ACC009):
    const transactions = [];
    let txCounter = 1;

    const addTx = (fromId, toId, amount, timestamp, note) => {
      const txId = `TX_SEED_${String(txCounter++).padStart(4, '0')}`;
      transactions.push({ fromId, toId, txId, amount, timestamp, note });
    };

    // Cài chu trình 1 (cách hiện tại 2 giờ)
    const c1BaseTime = now - 2 * 3600 * 1000;
    addTx('ACC001', 'ACC002', 50000000, c1BaseTime, 'Chuyển tiền đầu tư đợt 1');
    addTx('ACC002', 'ACC003', 49500000, c1BaseTime + 10 * 60 * 1000, 'Thanh toán hợp đồng dịch vụ');
    addTx('ACC003', 'ACC001', 49000000, c1BaseTime + 20 * 60 * 1000, 'Hoàn trả vốn ủy thác');

    // Cài chu trình 2 (cách hiện tại 5 giờ)
    const c2BaseTime = now - 5 * 3600 * 1000;
    addTx('ACC004', 'ACC005', 80000000, c2BaseTime, 'Mua hàng hóa lô A');
    addTx('ACC005', 'ACC006', 79000000, c2BaseTime + 15 * 60 * 1000, 'Chuyển phí tư vấn tài chính');
    addTx('ACC006', 'ACC004', 78500000, c2BaseTime + 30 * 60 * 1000, 'Tất toán công nợ nội bộ');

    // Cài chu trình 3 (cách hiện tại 10 giờ)
    const c3BaseTime = now - 10 * 3600 * 1000;
    addTx('ACC007', 'ACC008', 120000000, c3BaseTime, 'Giải ngân hợp đồng thương mại');
    addTx('ACC008', 'ACC009', 118000000, c3BaseTime + 12 * 60 * 1000, 'Chuyển khoản đối tác phụ');
    addTx('ACC009', 'ACC007', 117500000, c3BaseTime + 25 * 60 * 1000, 'Chi trả cổ tức tiền mặt');

    // Tạo thêm 105 giao dịch DAG ngẫu nhiên giữa ACC010 -> ACC050 (không tạo chu trình ngoài 3 chu trình đã cài)
    for (let k = 0; k < 105; k++) {
      const i = 10 + (k % 39);
      let step = 1 + ((k * 7) % (50 - i));
      if (i === 30 && step === 1) step = 2; // Giữ cạnh ACC030 -> ACC031 cho kịch bản demo chu trình #4
      const j = i + step;

      const fromId = `ACC${String(i).padStart(3, '0')}`;
      const toId = `ACC${String(j).padStart(3, '0')}`;

      const amount = (1 + ((k * 3) % 25)) * 1000000;
      const randomOffsetMs = Math.floor(((k + 1) / 110) * (thirtyDaysMs - 3600000));
      const timestamp = now - randomOffsetMs;

      addTx(fromId, toId, amount, timestamp, `Giao dịch chuyển khoản #${k + 1}`);
    }

    // Điểm 8: Cập nhật balance của các Account theo các giao dịch seed sao cho không có balance âm
    for (const tx of transactions) {
      const fromAcc = initialAccounts.get(tx.fromId);
      const toAcc = initialAccounts.get(tx.toId);
      if (fromAcc) fromAcc.balance -= tx.amount;
      if (toAcc) toAcc.balance += tx.amount;
    }

    // Đảm bảo không có tài khoản nào có balance âm
    for (const acc of initialAccounts.values()) {
      if (acc.balance < 10000000) {
        acc.balance += 200000000; // Cộng thêm nếu cần để luôn dương
      }
    }

    const accounts = Array.from(initialAccounts.values());

    await session.run(
      `
      UNWIND $accounts AS acc
      CREATE (:Account {
        accountId: acc.accountId,
        ownerName: acc.ownerName,
        passwordHash: acc.passwordHash,
        balance: acc.balance,
        status: acc.status,
        role: acc.role,
        createdAt: acc.createdAt
      })
      `,
      { accounts }
    );
    console.log(`[Neo4j] Đã tạo đúng ${accounts.length} Node (:Account) từ ACC001 đến ACC050 (đã cập nhật balance sau giao dịch).`);

    // Tạo đúng 3 Staff: STAFF001 (ADMIN), STAFF002 (ANALYST), STAFF003 (ANALYST)
    const staffs = [
      {
        staffId: 'STAFF001',
        fullName: 'Nguyễn Quản Trị',
        role: 'ADMIN',
        passwordHash: staffPasswordHash,
        status: 'ACTIVE',
        createdAt: now
      },
      {
        staffId: 'STAFF002',
        fullName: 'Trần Phân Tích',
        role: 'ANALYST',
        passwordHash: staffPasswordHash,
        status: 'ACTIVE',
        createdAt: now
      },
      {
        staffId: 'STAFF003',
        fullName: 'Lê Phân Tích',
        role: 'ANALYST',
        passwordHash: staffPasswordHash,
        status: 'ACTIVE',
        createdAt: now
      }
    ];

    await session.run(
      `
      UNWIND $staffs AS s
      CREATE (:Staff {
        staffId: s.staffId,
        fullName: s.fullName,
        role: s.role,
        passwordHash: s.passwordHash,
        status: s.status,
        createdAt: s.createdAt
      })
      `,
      { staffs }
    );
    console.log(`[Neo4j] Đã tạo đúng ${staffs.length} Node (:Staff) gồm 1 ADMIN (STAFF001) và 2 ANALYST (STAFF002, STAFF003).`);

    // Lưu toàn bộ giao dịch vào Neo4j
    await session.run(
      `
      UNWIND $transactions AS tx
      MATCH (from:Account {accountId: tx.fromId})
      MATCH (to:Account {accountId: tx.toId})
      CREATE (from)-[:TRANSFERRED {
        txId: tx.txId,
        amount: tx.amount,
        timestamp: tx.timestamp,
        note: tx.note
      }]->(to)
      `,
      { transactions }
    );

    console.log(`[Neo4j] Đã tạo ${transactions.length} giao dịch [:TRANSFERRED] (gồm 9 giao dịch thuộc 3 chu trình gian lận và 105 giao dịch DAG hợp lệ).`);

    // 6. Seed dữ liệu Redis: 3 tài khoản bị khóa (chỉ cần key login:lock:{id} EX 300, không cần login:fail)
    const lockDuration = Number(process.env.LOGIN_LOCK_SECONDS) || 300;
    const demoSeedTtl = Number(process.env.DEMO_SEED_TTL_SECONDS) || 3600;

    // 3 tài khoản đang bị khóa
    const lockedAccounts = ['ACC010', 'ACC011', 'ACC012'];
    for (const accId of lockedAccounts) {
      await redis.set(`login:lock:${accId}`, 'locked', 'EX', lockDuration);
    }

    // 9 tài khoản đang có bộ đếm đăng nhập sai từ 1 -> 4 lần (TTL = DEMO_SEED_TTL_SECONDS mặc định 3600)
    const failingAccounts = [
      { id: 'ACC013', fails: 4 },
      { id: 'ACC014', fails: 4 },
      { id: 'ACC015', fails: 3 },
      { id: 'ACC016', fails: 3 },
      { id: 'ACC017', fails: 2 },
      { id: 'ACC018', fails: 2 },
      { id: 'ACC019', fails: 1 },
      { id: 'ACC020', fails: 1 },
      { id: 'ACC021', fails: 3 }
    ];

    for (const item of failingAccounts) {
      await redis.set(`login:fail:${item.id}`, item.fails, 'EX', demoSeedTtl);
    }

    console.log(`[Redis] Đã khởi tạo 12 tài khoản trong Redis (3 tài khoản khóa EX ${lockDuration}s; 9 tài khoản fail EX ${demoSeedTtl}s).`);
    console.log('----------------------------------------------------------');
    console.log('3 CHU TRÌNH GIAN LẬN ĐÃ CÀI SẴN TRONG NEO4J:');
    console.log('  1) ACC001 -> ACC002 -> ACC003 -> ACC001 (Tổng: 148,500,000 VNĐ)');
    console.log('  2) ACC004 -> ACC005 -> ACC006 -> ACC004 (Tổng: 237,500,000 VNĐ)');
    console.log('  3) ACC007 -> ACC008 -> ACC009 -> ACC007 (Tổng: 355,500,000 VNĐ)');
    console.log('----------------------------------------------------------');

    return {
      success: true,
      accountsCreated: accounts.length,
      staffsCreated: staffs.length,
      transactionsCreated: transactions.length,
      plantedCycles: [
        'ACC001 → ACC002 → ACC003 → ACC001',
        'ACC004 → ACC005 → ACC006 → ACC004',
        'ACC007 → ACC008 → ACC009 → ACC007'
      ],
      lockedAccounts
    };
  } finally {
    await session.close();
  }
}

// Nếu chạy trực tiếp bằng lệnh `node src/seed.js` hoặc `npm run seed`
if (require.main === module) {
  seedAllData()
    .then(async () => {
      await driver.close();
      await redis.quit();
      process.exit(0);
    })
    .catch(async (err) => {
      console.error('Lỗi khi chạy seed:', err);
      await driver.close();
      await redis.quit();
      process.exit(1);
    });
}

module.exports = { seedAllData };
