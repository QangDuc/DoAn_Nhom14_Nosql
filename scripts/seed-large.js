require('dotenv').config();
const { driver } = require('../src/config/neo4j');

/**
 * Hàm sinh số ngẫu nhiên giả lập có seed cố định (Mulberry32 PRNG)
 * Đảm bảo kết quả phân phối lặp lại đồng nhất 100% trên mọi môi trường
 */
function createPrng(seed = 16042026) {
  let s = seed >>> 0;
  return function () {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Xóa sạch toàn bộ dữ liệu kiểm thử :BenchAccount và ràng buộc tạm thời
 */
async function cleanupLargeDataset() {
  const session = driver.session();
  try {
    console.log('[Bench Clean] Đang dọn dẹp dữ liệu :BenchAccount và cạnh :BENCH_TRANSFER...');
    await session.run(`MATCH (a:BenchAccount) DETACH DELETE a`);
    try {
      await session.run(`DROP CONSTRAINT bench_account_id_unique IF EXISTS`);
      await session.run(`DROP INDEX bench_transfer_txid_idx IF EXISTS`);
      await session.run(`DROP INDEX bench_transfer_timestamp_idx IF EXISTS`);
    } catch (_) {}
    console.log('[Bench Clean] Đã xóa sạch dữ liệu :BenchAccount thành công.');
  } finally {
    await session.close();
  }
}

/**
 * Khởi tạo dữ liệu quy mô lớn (Large Dataset) cho Benchmark:
 * - 1.000 Node (:BenchAccount) từ BENCH_0001 đến BENCH_1000
 * - 10.000 Cạnh [:BENCH_TRANSFER]
 * - Cài đặt đúng 20 chu trình 3 đỉnh khép kín
 * - Phân phối ngẫu nhiên có seed cố định (Deterministic PRNG)
 */
async function seedLargeDataset() {
  const session = driver.session();
  const prng = createPrng(16042026);
  const now = Date.now();
  const thirtyDaysMs = 30 * 24 * 3600 * 1000;

  try {
    console.log('==========================================================');
    console.log('[Seed-Large] Khởi tạo 1.000 :BenchAccount & 10.000 :BENCH_TRANSFER');
    console.log('==========================================================');

    // 1. Dọn dẹp dữ liệu cũ trước khi nạp
    await session.run(`MATCH (a:BenchAccount) DETACH DELETE a`);

    // 2. Tạo UNIQUE Constraint trên BenchAccount.accountId
    try {
      await session.run(`
        CREATE CONSTRAINT bench_account_id_unique IF NOT EXISTS
        FOR (a:BenchAccount) REQUIRE a.accountId IS UNIQUE
      `);
    } catch (_) {}

    // 3. Tạo 1.000 node :BenchAccount (theo 2 batch 500)
    const totalAccounts = 1000;
    const accountBatchSize = 500;
    for (let b = 0; b < totalAccounts; b += accountBatchSize) {
      const accounts = [];
      for (let i = b + 1; i <= b + accountBatchSize; i++) {
        accounts.push({
          accountId: `BENCH_${String(i).padStart(4, '0')}`,
          ownerName: `Bench User ${i}`,
          balance: 100000000,
          status: 'ACTIVE',
          createdAt: now - (totalAccounts - i) * 60000
        });
      }
      await session.run(
        `
        UNWIND $accounts AS acc
        CREATE (:BenchAccount {
          accountId: acc.accountId,
          ownerName: acc.ownerName,
          balance: acc.balance,
          status: acc.status,
          createdAt: acc.createdAt
        })
        `,
        { accounts }
      );
      console.log(`[Seed-Large] Đã tạo ${b + accounts.length}/${totalAccounts} node :BenchAccount.`);
    }

    // 4. Tạo đúng 20 chu trình 3 đỉnh độc lập (60 cạnh)
    // Các chu trình nằm trên 60 tài khoản đầu tiên: (1,2,3), (4,5,6), ..., (58,59,60)
    const cycleTxs = [];
    let txCounter = 1;

    for (let c = 0; c < 20; c++) {
      const u1 = 3 * c + 1;
      const u2 = 3 * c + 2;
      const u3 = 3 * c + 3;
      const baseTime = now - Math.floor(prng() * thirtyDaysMs);
      const stepMs = Math.floor(prng() * 3600000) + 60000;

      cycleTxs.push({
        fromId: `BENCH_${String(u1).padStart(4, '0')}`,
        toId: `BENCH_${String(u2).padStart(4, '0')}`,
        txId: `TX_BENCH_${String(txCounter++).padStart(6, '0')}`,
        amount: Math.floor(10 + prng() * 40) * 1000000,
        timestamp: baseTime,
        note: `Bench cycle #${c + 1} step 1`
      });

      cycleTxs.push({
        fromId: `BENCH_${String(u2).padStart(4, '0')}`,
        toId: `BENCH_${String(u3).padStart(4, '0')}`,
        txId: `TX_BENCH_${String(txCounter++).padStart(6, '0')}`,
        amount: Math.floor(10 + prng() * 40) * 1000000,
        timestamp: baseTime + stepMs,
        note: `Bench cycle #${c + 1} step 2`
      });

      cycleTxs.push({
        fromId: `BENCH_${String(u3).padStart(4, '0')}`,
        toId: `BENCH_${String(u1).padStart(4, '0')}`,
        txId: `TX_BENCH_${String(txCounter++).padStart(6, '0')}`,
        amount: Math.floor(10 + prng() * 40) * 1000000,
        timestamp: baseTime + stepMs * 2,
        note: `Bench cycle #${c + 1} step 3`
      });
    }

    await session.run(
      `
      UNWIND $txs AS tx
      MATCH (from:BenchAccount {accountId: tx.fromId})
      MATCH (to:BenchAccount {accountId: tx.toId})
      CREATE (from)-[:BENCH_TRANSFER {
        txId: tx.txId,
        amount: tx.amount,
        timestamp: tx.timestamp,
        note: tx.note
      }]->(to)
      `,
      { txs: cycleTxs }
    );
    console.log(`[Seed-Large] Đã cài đúng 20 chu trình 3 đỉnh (${cycleTxs.length} cạnh :BENCH_TRANSFER).`);

    // 5. Tạo 9.940 cạnh DAG ngẫu nhiên còn lại (tổng đúng 10.000 cạnh)
    // Các cạnh lấy từ các tài khoản 61..1000 với điều kiện ngặt fromId < toId
    // Điều này đảm bảo về mặt lý thuyết đồ thị không phát sinh thêm bất kỳ chu trình nào khác ngoài 20 chu trình đã cài đặt
    const totalRemaining = 10000 - cycleTxs.length; // 9.940
    const edgePairs = new Set();
    cycleTxs.forEach((t) => edgePairs.add(`${t.fromId}:${t.toId}`));

    const dagTxs = [];
    while (dagTxs.length < totalRemaining) {
      const a = 61 + Math.floor(prng() * 939); // 61 .. 999
      const b = a + 1 + Math.floor(prng() * (1000 - a)); // a+1 .. 1000
      const fromId = `BENCH_${String(a).padStart(4, '0')}`;
      const toId = `BENCH_${String(b).padStart(4, '0')}`;
      const pairKey = `${fromId}:${toId}`;

      if (!edgePairs.has(pairKey)) {
        edgePairs.add(pairKey);
        const amount = (1 + Math.floor(prng() * 50)) * 1000000;
        const timestamp = now - Math.floor(prng() * thirtyDaysMs);
        dagTxs.push({
          fromId,
          toId,
          txId: `TX_BENCH_${String(txCounter++).padStart(6, '0')}`,
          amount,
          timestamp,
          note: `Bench DAG transfer #${txCounter}`
        });
      }
    }

    const txBatchSize = 1000;
    for (let b = 0; b < dagTxs.length; b += txBatchSize) {
      const batch = dagTxs.slice(b, b + txBatchSize);
      await session.run(
        `
        UNWIND $txs AS tx
        MATCH (from:BenchAccount {accountId: tx.fromId})
        MATCH (to:BenchAccount {accountId: tx.toId})
        CREATE (from)-[:BENCH_TRANSFER {
          txId: tx.txId,
          amount: tx.amount,
          timestamp: tx.timestamp,
          note: tx.note
        }]->(to)
        `,
        { txs: batch }
      );
      console.log(`[Seed-Large] Đã nạp ${cycleTxs.length + b + batch.length}/10.000 cạnh :BENCH_TRANSFER.`);
    }

    // 6. Tạo index mặc định trên txId
    try {
      await session.run(`
        CREATE INDEX bench_transfer_txid_idx IF NOT EXISTS
        FOR ()-[r:BENCH_TRANSFER]-() ON (r.txId)
      `);
    } catch (_) {}

    console.log('[Seed-Large] Hoàn tất nạp 1.000 :BenchAccount và đúng 10.000 :BENCH_TRANSFER (20 chu trình 3 đỉnh).');
    return { accounts: totalAccounts, transactions: 10000, cycles: 20 };
  } finally {
    await session.close();
  }
}

if (require.main === module) {
  const isClean = process.argv.includes('--clean');
  const action = isClean ? cleanupLargeDataset() : seedLargeDataset();

  action
    .then(async () => {
      await driver.close();
      process.exit(0);
    })
    .catch(async (err) => {
      console.error('[Seed-Large] Lỗi:', err.message || err);
      await driver.close();
      process.exit(1);
    });
}

module.exports = { seedLargeDataset, cleanupLargeDataset };
