require('dotenv').config();
const path = require('path');
const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const { initNeo4jSchema, isUsingFallback: isNeo4jFallback } = require('./config/neo4j');
const redis = require('./config/redis');
const { seedAllData } = require('./seed');
const { requireRole } = require('./middleware/authMiddleware');
const { logAudit } = require('./services/audit');

const authRoutes = require('./routes/auth');
const staffRoutes = require('./routes/staff');
const meRoutes = require('./routes/me');
const accountRoutes = require('./routes/accounts');
const transactionRoutes = require('./routes/transactions');
const fraudRoutes = require('./routes/fraud');
const securityRoutes = require('./routes/security');
const riskRoutes = require('./routes/risk');
const eventRoutes = require('./routes/events');
const demoRoutes = require('./routes/demo');

const app = express();
const PORT = Number(process.env.PORT) || 3000;

app.use(cors());
app.use(cookieParser());
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

// Điểm 7: GET /api/health trả {neo4j: "real"|"fallback", redis: "real"|"fallback"}
app.get('/api/health', (req, res) => {
  const neo4jStatus = isNeo4jFallback() ? 'fallback' : 'real';
  const redisStatus = (typeof redis.isUsingFallback === 'function' && redis.isUsingFallback()) ? 'fallback' : 'real';
  return res.json({
    neo4j: neo4jStatus,
    redis: redisStatus
  });
});

// Đăng ký các cụm REST API
app.use('/api/auth', authRoutes);
app.use('/api/staff', staffRoutes);
app.use('/api/me', meRoutes);
app.use('/api/accounts', accountRoutes);
app.use('/api/transactions', transactionRoutes);
app.use('/api/fraud', fraudRoutes);
app.use('/api/security', securityRoutes);
app.use('/api/risk', riskRoutes);
app.use('/api/events', eventRoutes);
app.use('/api/demo', demoRoutes);

// Endpoint tiện ích trên Dashboard để Reset toàn bộ dữ liệu Demo về trạng thái gốc (Chỉ ADMIN)
app.post('/api/admin/seed-reset', requireRole('ADMIN'), async (req, res) => {
  try {
    const summary = await seedAllData();
    await logAudit({
      actor: req.sessionUser.subjectId,
      role: req.sessionUser.role,
      action: 'SEED_RESET',
      target: 'DATABASE',
      ip: req.sessionUser.ip
    });
    return res.json({
      message: 'Đã Reset và khởi tạo lại toàn bộ dữ liệu mẫu Neo4j + Redis thành công!',
      summary
    });
  } catch (err) {
    console.error('[Seed Reset API] Lỗi:', err.message);
    return res.status(500).json({ error: 'Lỗi khi reset dữ liệu mẫu: ' + err.message });
  }
});

// Endpoint nạp giao dịch mẫu cho 3 mẫu gian lận nâng cao (Chỉ ADMIN)
app.post('/api/admin/seed-patterns', requireRole('ADMIN'), async (req, res) => {
  const { driver } = require('./config/neo4j');
  const session = driver.session();
  try {
    const now = Date.now();
    // Danh sách 15 giao dịch mẫu thỏa mãn 3 pattern, chỉ đi từ ID thấp lên ID cao (DAG, không chu trình)
    const patternTxs = [
      // 1. Structuring: ACC034 -> ACC035 (3 giao dịch < 10M, tổng >= 20M trong 24h)
      { txId: 'TX_PATTERN_STR_001', fromId: 'ACC034', toId: 'ACC035', amount: 7500000, timestamp: now - 3600000, note: 'Giao dịch chia nhỏ đợt 1 (Structuring)' },
      { txId: 'TX_PATTERN_STR_002', fromId: 'ACC034', toId: 'ACC035', amount: 8000000, timestamp: now - 2400000, note: 'Giao dịch chia nhỏ đợt 2 (Structuring)' },
      { txId: 'TX_PATTERN_STR_003', fromId: 'ACC034', toId: 'ACC035', amount: 7000000, timestamp: now - 1200000, note: 'Giao dịch chia nhỏ đợt 3 (Structuring)' },

      // 2. Passthrough: ACC036, ACC037, ACC038 -> ACC039 -> ACC040 (nhận >= 60M từ >= 3 nguồn trong 30p, chuyển đi >= 90% trong 30p tiếp)
      { txId: 'TX_PATTERN_PASS_001', fromId: 'ACC036', toId: 'ACC039', amount: 25000000, timestamp: now - 1500000, note: 'Nguồn chuyển tiền 1 (Passthrough)' },
      { txId: 'TX_PATTERN_PASS_002', fromId: 'ACC037', toId: 'ACC039', amount: 25000000, timestamp: now - 1200000, note: 'Nguồn chuyển tiền 2 (Passthrough)' },
      { txId: 'TX_PATTERN_PASS_003', fromId: 'ACC038', toId: 'ACC039', amount: 25000000, timestamp: now - 900000, note: 'Nguồn chuyển tiền 3 (Passthrough)' },
      { txId: 'TX_PATTERN_PASS_004', fromId: 'ACC039', toId: 'ACC040', amount: 70000000, timestamp: now - 300000, note: 'Chuyển tiếp dòng tiền (Passthrough Out)' },

      // 3. Fanout: ACC041 -> ACC042..ACC049 (chuyển cho 8 tài khoản khác nhau trong 1h)
      { txId: 'TX_PATTERN_FAN_001', fromId: 'ACC041', toId: 'ACC042', amount: 2000000, timestamp: now - 1800000, note: 'Phân tán dòng tiền 1 (Fanout)' },
      { txId: 'TX_PATTERN_FAN_002', fromId: 'ACC041', toId: 'ACC043', amount: 2000000, timestamp: now - 1600000, note: 'Phân tán dòng tiền 2 (Fanout)' },
      { txId: 'TX_PATTERN_FAN_003', fromId: 'ACC041', toId: 'ACC044', amount: 2000000, timestamp: now - 1400000, note: 'Phân tán dòng tiền 3 (Fanout)' },
      { txId: 'TX_PATTERN_FAN_004', fromId: 'ACC041', toId: 'ACC045', amount: 2000000, timestamp: now - 1200000, note: 'Phân tán dòng tiền 4 (Fanout)' },
      { txId: 'TX_PATTERN_FAN_005', fromId: 'ACC041', toId: 'ACC046', amount: 2000000, timestamp: now - 1000000, note: 'Phân tán dòng tiền 5 (Fanout)' },
      { txId: 'TX_PATTERN_FAN_006', fromId: 'ACC041', toId: 'ACC047', amount: 2000000, timestamp: now - 800000, note: 'Phân tán dòng tiền 6 (Fanout)' },
      { txId: 'TX_PATTERN_FAN_007', fromId: 'ACC041', toId: 'ACC048', amount: 2000000, timestamp: now - 600000, note: 'Phân tán dòng tiền 7 (Fanout)' },
      { txId: 'TX_PATTERN_FAN_008', fromId: 'ACC041', toId: 'ACC049', amount: 2000000, timestamp: now - 400000, note: 'Phân tán dòng tiền 8 (Fanout)' }
    ];

    // Xóa các pattern cũ nếu có để đảm bảo tính Idempotent
    await session.run(`MATCH ()-[r:TRANSFERRED]->() WHERE r.txId STARTS WITH 'TX_PATTERN_' DELETE r`);

    // Chèn danh sách giao dịch mẫu
    await session.run(
      `
      UNWIND $patternTxs AS tx
      MATCH (from:Account {accountId: tx.fromId})
      MATCH (to:Account {accountId: tx.toId})
      SET from.balance = from.balance - tx.amount,
          to.balance = to.balance + tx.amount
      CREATE (from)-[r:TRANSFERRED {
        txId: tx.txId,
        amount: tx.amount,
        timestamp: tx.timestamp,
        note: tx.note
      }]->(to)
      `,
      { patternTxs }
    );

    await logAudit({
      actor: req.sessionUser.subjectId,
      role: req.sessionUser.role,
      action: 'SEED_PATTERNS',
      target: 'DATABASE',
      ip: req.sessionUser.ip
    });

    return res.json({
      message: 'Đã nạp thành công 15 giao dịch mẫu cho 3 mẫu gian lận (Structuring, Passthrough, Fanout)',
      insertedCount: patternTxs.length,
      patterns: {
        structuring: 'ACC034 → ACC035 (3 giao dịch, tổng 22.5M)',
        passthrough: 'ACC036,037,038 → ACC039 → ACC040 (nhận 75M, chuyển đi 70M)',
        fanout: 'ACC041 → ACC042..ACC049 (8 giao dịch, tổng 16M)'
      }
    });
  } catch (err) {
    console.error('[Seed Patterns API] Lỗi:', err.message);
    return res.status(500).json({ error: 'Lỗi khi nạp dữ liệu mẫu: ' + err.message });
  } finally {
    await session.close();
  }
});

// Khởi động Server khi chạy trực tiếp từ CLI
if (require.main === module) {
  app.listen(PORT, async () => {
    console.log(`==========================================================`);
    console.log(`Server đang chạy tại: http://localhost:${PORT}`);
    console.log(`Dashboard Admin:      http://localhost:${PORT}/index.html`);
    console.log(`==========================================================`);
    await initNeo4jSchema();

    // Điểm 7: Kiểm tra STRICT_DB=true
    if (process.env.STRICT_DB === 'true') {
      const neo4jIsFallback = isNeo4jFallback();
      const redisIsFallback = (typeof redis.isUsingFallback === 'function' && redis.isUsingFallback());
      if (neo4jIsFallback || redisIsFallback) {
        console.error(`[STRICT_DB ERROR] Server dừng do cấu hình STRICT_DB=true nhưng CSDL đang ở chế độ fallback (Neo4j: ${neo4jIsFallback ? 'fallback' : 'real'}, Redis: ${redisIsFallback ? 'fallback' : 'real'}). Vui lòng khởi động Docker container Neo4j và Redis!`);
        process.exit(1);
      }
    }

    // Nếu máy chưa có dữ liệu hoặc đang chạy chế độ Fallback không cần Docker, tự động seed luôn 50 Account + 3 Chu trình
    try {
      const { driver } = require('./config/neo4j');
      const session = driver.session();
      const check = await session.run(`MATCH (a:Account) RETURN a ORDER BY a.accountId ASC`);
      await session.close();
      if (check.records.length === 0) {
        console.log('[Auto-Seed] Phát hiện CSDL chưa có dữ liệu -> Đang tự động khởi tạo dữ liệu mẫu...');
        await seedAllData();
      }
    } catch (err) {
      console.error('[Auto-Seed] Lỗi kiểm tra dữ liệu ban đầu:', err.message);
    }
  });
}

module.exports = app;
