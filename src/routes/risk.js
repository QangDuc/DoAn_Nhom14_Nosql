const express = require('express');
const { driver } = require('../config/neo4j');
const redis = require('../config/redis');
const { requireRole } = require('../middleware/authMiddleware');

const router = express.Router();

/**
 * GET /api/risk/scores
 * Tính toán điểm rủi ro (Risk Scores) cho toàn bộ tài khoản kết hợp Neo4j (Đồ thị) và Redis (Key-Value)
 * Yêu cầu quyền ADMIN hoặc ANALYST
 * Sử dụng Redis Pipeline để truy vấn hàng loạt với hiệu năng tối đa.
 */
router.get('/scores', requireRole('ADMIN', 'ANALYST'), async (req, res) => {
  const session = driver.session();
  try {
    // 1. Lấy danh sách tài khoản cùng số đối tác duy nhất từ Neo4j
    const accountsRes = await session.run(
      `
      MATCH (a:Account)
      OPTIONAL MATCH (a)-[:TRANSFERRED]-(partner:Account)
      WHERE a <> partner
      RETURN a.accountId AS accountId, a.ownerName AS ownerName, count(DISTINCT partner.accountId) AS partnerCount
      ORDER BY a.accountId ASC
      `
    );

    const accounts = accountsRes.records.map(rec => ({
      accountId: rec.get('accountId'),
      ownerName: rec.get('ownerName'),
      partnerCount: Number(rec.get('partnerCount')) || 0
    }));

    // 2. Tìm tất cả các tài khoản nằm trong chu trình gian lận 3 đỉnh từ Neo4j
    const cycleRes = await session.run(
      `
      MATCH (a:Account)-[r1:TRANSFERRED]->(b:Account)-[r2:TRANSFERRED]->(c:Account)-[r3:TRANSFERRED]->(a)
      WHERE a.accountId < b.accountId AND a.accountId < c.accountId AND b.accountId <> c.accountId
      RETURN a.accountId AS accA, b.accountId AS accB, c.accountId AS accC
      `
    );

    const cycleSet = new Set();
    for (const rec of cycleRes.records) {
      cycleSet.add(rec.get('accA'));
      cycleSet.add(rec.get('accB'));
      cycleSet.add(rec.get('accC'));
    }

    // 3. Sử dụng Redis Pipeline để lấy thông tin đăng nhập sai (login:fail) và khóa (login:lock)
    const pipeline = redis.pipeline();
    for (const acc of accounts) {
      pipeline.get(`login:fail:${acc.accountId}`);
      pipeline.get(`login:lock:${acc.accountId}`);
    }
    const redisResults = await pipeline.exec();

    // 4. Tính toán điểm rủi ro theo công thức chuẩn
    const scores = accounts.map((acc, idx) => {
      const failVal = redisResults[idx * 2] ? redisResults[idx * 2][1] : null;
      const lockVal = redisResults[idx * 2 + 1] ? redisResults[idx * 2 + 1][1] : null;

      const loginFailures = Number(failVal) || 0;
      const isLocked = lockVal !== null && lockVal !== undefined;
      const inCycle = cycleSet.has(acc.accountId);
      const partnerCount = acc.partnerCount;

      const cyclePoints = inCycle ? 40 : 0;
      const partnerPoints = Math.min(20, 2 * partnerCount);
      const failPoints = Math.min(25, 5 * loginFailures);
      const lockPoints = isLocked ? 15 : 0;

      const totalScore = Math.min(100, cyclePoints + partnerPoints + failPoints + lockPoints);

      let level = 'LOW';
      if (totalScore >= 60) {
        level = 'HIGH';
      } else if (totalScore >= 30) {
        level = 'MEDIUM';
      }

      return {
        accountId: acc.accountId,
        ownerName: acc.ownerName,
        score: totalScore,
        level,
        factors: {
          inCycle,
          partnerCount,
          loginFailures,
          isLocked
        }
      };
    });

    return res.json(scores);
  } catch (err) {
    console.error('[GET /risk/scores] Lỗi:', err.message);
    return res.status(500).json({ error: 'Lỗi tính toán điểm rủi ro: ' + err.message });
  } finally {
    await session.close();
  }
});

module.exports = router;

