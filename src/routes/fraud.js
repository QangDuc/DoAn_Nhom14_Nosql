const express = require('express');
const neo4j = require('neo4j-driver');
const { driver, isUsingFallback } = require('../config/neo4j');
const { requireRole } = require('../middleware/authMiddleware');
const {
  CYPHER_CYCLES_3,
  getCypherCyclesLong,
  CYPHER_STRUCTURING,
  CYPHER_PASSTHROUGH,
  CYPHER_FANOUT,
  getQueryDefinition
} = require('../services/cypherQueries');

const router = express.Router();

/**
 * GET /api/fraud/cycles
 * Quét chu trình rửa tiền khép kín 3 node: (a)-[:TRANSFERRED]->(b)-[:TRANSFERRED]->(c)-[:TRANSFERRED]->(a)
 * Tham số query tùy chọn:
 *  - windowHours: Cửa sổ thời gian tối đa giữa giao dịch sớm nhất và muộn nhất trong chu trình (mặc định: không giới hạn hoặc truyền số giờ, ví dụ 24)
 *  - minAmount: Ngưỡng số tiền tối thiểu của mỗi giao dịch trong chu trình (mặc định: 0)
 * Trả về:
 *  - Danh sách cycles (gom theo bộ ba a,b,c để mỗi chu trình chỉ ra 1 dòng)
 *  - Dữ liệu nodes và edges cho vis-network (đánh dấu isFraud = true cho các đỉnh/cạnh thuộc chu trình)
 */
router.get('/cycles', async (req, res) => {
  const windowHours = req.query.windowHours ? Number(req.query.windowHours) : null;
  const minAmount = req.query.minAmount ? Number(req.query.minAmount) : 0;

  const session = driver.session();
  try {
    // 1. Truy vấn Cypher tìm chu trình 3 đỉnh khép kín A -> B -> C -> A
    const standardCypher = CYPHER_CYCLES_3;

    const windowMs = windowHours && windowHours > 0 ? windowHours * 3600 * 1000 : null;

    const cycleResult = await session.run(standardCypher, {
      minAmount,
      windowMs
    });

    const fraudNodeIds = new Set();
    const fraudTxIds = new Set();

    // Gom theo bộ ba ở tầng xử lý để bảo đảm an toàn kép (phòng trường hợp driver/kết quả nhiều dòng)
    const tripletMap = new Map();

    for (let idx = 0; idx < cycleResult.records.length; idx++) {
      const rec = cycleResult.records[idx];
      const accA = rec.get('accA');
      const accB = rec.get('accB');
      const accC = rec.get('accC');
      const tripKey = `${accA}:${accB}:${accC}`;

      let recTxIds = rec.get('txIds');
      if (!recTxIds || !Array.isArray(recTxIds)) {
        recTxIds = [rec.get('tx1'), rec.get('tx2'), rec.get('tx3')].filter(Boolean);
      }
      const recTotalAmount = Number(rec.get('totalAmount')) || 0;
      const recTransferCount = Number(rec.get('transferCount')) || recTxIds.length;
      const recMinTime = Number(rec.get('minTime')) || 0;
      const recMaxTime = Number(rec.get('maxTime')) || 0;
      const recDurationMs = Number(rec.get('durationMs')) || (recMaxTime - recMinTime);

      if (!tripletMap.has(tripKey)) {
        tripletMap.set(tripKey, {
          accA, nameA: rec.get('nameA'),
          accB, nameB: rec.get('nameB'),
          accC, nameC: rec.get('nameC'),
          txIdSet: new Set(recTxIds),
          totalAmount: recTotalAmount,
          transferCount: recTransferCount,
          minTime: recMinTime,
          maxTime: recMaxTime,
          durationMs: recDurationMs
        });
      } else {
        const existing = tripletMap.get(tripKey);
        for (const tId of recTxIds) {
          existing.txIdSet.add(tId);
        }
        existing.totalAmount = Math.max(existing.totalAmount, recTotalAmount);
        existing.transferCount = existing.txIdSet.size;
        existing.minTime = Math.min(existing.minTime, recMinTime);
        existing.maxTime = Math.max(existing.maxTime, recMaxTime);
        existing.durationMs = existing.maxTime - existing.minTime;
      }
    }

    const cycles = Array.from(tripletMap.values()).map((trip, idx) => {
      fraudNodeIds.add(trip.accA);
      fraudNodeIds.add(trip.accB);
      fraudNodeIds.add(trip.accC);

      const txIds = Array.from(trip.txIdSet);
      for (const tId of txIds) {
        fraudTxIds.add(tId);
      }

      const durationMinutes = Math.round(trip.durationMs / 60000);

      return {
        cycleId: `CYCLE_${idx + 1}`,
        path: `${trip.accA} → ${trip.accB} → ${trip.accC} → ${trip.accA}`,
        accounts: [
          { accountId: trip.accA, ownerName: trip.nameA },
          { accountId: trip.accB, ownerName: trip.nameB },
          { accountId: trip.accC, ownerName: trip.nameC }
        ],
        txIds,
        transferCount: txIds.length,
        totalAmount: trip.totalAmount,
        minTime: trip.minTime,
        maxTime: trip.maxTime,
        durationMs: trip.durationMs,
        durationText: durationMinutes < 60
          ? `${durationMinutes} phút`
          : `${(durationMinutes / 60).toFixed(1)} giờ`
      };
    });

    // 2. Lấy toàn bộ Account và giao dịch TRANSFERRED để dựng đồ thị vis-network
    const allAccountsRes = await session.run(`
      MATCH (a:Account)
      RETURN a.accountId AS accountId, a.ownerName AS ownerName, a.balance AS balance, a.status AS status
      ORDER BY a.accountId ASC
    `);

    const allTxRes = await session.run(`
      MATCH (a:Account)-[r:TRANSFERRED]->(b:Account)
      RETURN a.accountId AS fromAccount,
             b.accountId AS toAccount,
             r.txId AS txId,
             r.amount AS amount,
             r.timestamp AS timestamp,
             r.note AS note
      ORDER BY r.timestamp DESC
    `);

    const nodes = allAccountsRes.records.map(rec => {
      const id = rec.get('accountId');
      const isFraud = fraudNodeIds.has(id);
      return {
        id,
        label: `${id}\n(${rec.get('ownerName')})`,
        ownerName: rec.get('ownerName'),
        balance: rec.get('balance'),
        status: rec.get('status'),
        isFraud
      };
    });

    const edges = allTxRes.records.map(rec => {
      const txId = rec.get('txId');
      const amount = rec.get('amount');
      const isFraud = fraudTxIds.has(txId);
      return {
        id: txId,
        from: rec.get('fromAccount'),
        to: rec.get('toAccount'),
        label: `${(amount / 1000000).toFixed(1)}M`,
        amount,
        timestamp: rec.get('timestamp'),
        note: rec.get('note'),
        isFraud
      };
    });

    return res.json({
      filters: {
        windowHours: windowHours || 'ALL',
        minAmount
      },
      summary: {
        cycleCount: cycles.length,
        fraudAccountCount: fraudNodeIds.size,
        fraudTxCount: fraudTxIds.size,
        totalNodes: nodes.length,
        totalEdges: edges.length
      },
      cycles,
      nodes,
      edges
    });
  } catch (err) {
    console.error('[Fraud Cycles] Lỗi:', err.message);
    return res.status(500).json({ error: 'Lỗi khi quét chu trình gian lận trên Neo4j' });
  } finally {
    await session.close();
  }
});

/**
 * 1. GET /api/fraud/cycles/long
 * Quét chu trình độ dài biến đổi (a)-[:TRANSFERRED*minLen..maxLen]->(a) (từ 3 đến 5 đỉnh)
 * Yêu cầu quyền ADMIN hoặc ANALYST, timeout giao dịch 5000ms.
 */
router.get('/cycles/long', requireRole('ADMIN', 'ANALYST'), async (req, res) => {
  if (isUsingFallback() && process.env.ALLOW_FALLBACK_ANALYTICS !== 'true' && req.headers['x-allow-fallback'] !== 'true') {
    return res.status(503).json({ error: 'Cần Neo4j/Redis thật' });
  }

  const minLen = req.query.minLen !== undefined ? Number(req.query.minLen) : 3;
  const maxLen = req.query.maxLen !== undefined ? Number(req.query.maxLen) : 5;

  if (isNaN(minLen) || isNaN(maxLen) || minLen < 3 || maxLen > 5 || minLen > maxLen) {
    return res.status(400).json({
      error: 'Tham số không hợp lệ: minLen phải >= 3 và maxLen tối đa 5 (minLen <= maxLen)'
    });
  }

  const limitRaw = req.query.limit !== undefined ? Number(req.query.limit) : 50;
  if (isNaN(limitRaw) || limitRaw <= 0) {
    return res.status(400).json({ error: 'Tham số limit không hợp lệ' });
  }
  const limit = Math.min(100, limitRaw);

  const windowHours = req.query.windowHours ? Number(req.query.windowHours) : null;
  const windowMs = windowHours && windowHours > 0 ? windowHours * 3600 * 1000 : 0;
  const minAmount = req.query.minAmount ? Number(req.query.minAmount) : 0;
  const ordered = req.query.ordered === 'true' || req.query.ordered === true;

  const session = driver.session();
  const startTime = Date.now();

  try {
    const cypherQuery = getCypherCyclesLong(minLen, maxLen);

    const result = await session.executeRead(
      tx => tx.run(cypherQuery, {
        minAmount,
        ordered,
        windowMs,
        limit: neo4j.int ? neo4j.int(limit) : limit
      }),
      { timeout: 5000 }
    );

    const execDurationMs = Date.now() - startTime;

    const cycles = result.records.map(rec => {
      let len = rec.get('length');
      if (typeof len === 'object' && len !== null && typeof len.toNumber === 'function') {
        len = len.toNumber();
      }
      let tot = rec.get('totalAmount');
      if (typeof tot === 'object' && tot !== null && typeof tot.toNumber === 'function') {
        tot = tot.toNumber();
      }
      let dur = rec.get('durationMs');
      if (typeof dur === 'object' && dur !== null && typeof dur.toNumber === 'function') {
        dur = dur.toNumber();
      }

      return {
        length: Number(len),
        path: rec.get('path'),
        accounts: rec.get('accounts'),
        txIds: rec.get('txIds'),
        totalAmount: Number(tot),
        durationMs: Number(dur)
      };
    });

    return res.json({
      count: cycles.length,
      durationMs: execDurationMs,
      cycles
    });
  } catch (err) {
    const elapsed = Date.now() - startTime;
    if (elapsed >= 5000 || (err.message && (err.message.includes('timeout') || err.message.includes('TimedOut')))) {
      return res.status(504).json({ error: 'Truy vấn vượt quá thời gian tối đa 5000ms (Gateway Timeout)' });
    }
    console.error('[GET /cycles/long] Lỗi:', err.message);
    return res.status(500).json({ error: 'Lỗi thực thi truy vấn chu trình dài: ' + err.message });
  } finally {
    await session.close();
  }
});

/**
 * 2. GET /api/fraud/patterns?type=structuring|passthrough|fanout
 * Phân tích và phát hiện 3 mẫu gian lận rửa tiền phức tạp trên đồ thị
 * Yêu cầu quyền ADMIN hoặc ANALYST, timeout giao dịch 5000ms.
 */
router.get('/patterns', requireRole('ADMIN', 'ANALYST'), async (req, res) => {
  if (isUsingFallback() && process.env.ALLOW_FALLBACK_ANALYTICS !== 'true' && req.headers['x-allow-fallback'] !== 'true') {
    return res.status(503).json({ error: 'Cần Neo4j/Redis thật' });
  }

  const { type } = req.query;
  const validTypes = ['structuring', 'passthrough', 'fanout'];
  if (!type || !validTypes.includes(type.toLowerCase())) {
    return res.status(400).json({
      error: 'type không hợp lệ. Vui lòng chọn một trong: structuring, passthrough, fanout'
    });
  }

  const patternType = type.toLowerCase();
  const session = driver.session();
  const startTime = Date.now();

  try {
    let cypherQuery = '';
    let params = {};

    if (patternType === 'structuring') {
      cypherQuery = CYPHER_STRUCTURING;
      params = {
        maxAmountPerTx: 10000000,
        minTxCount: 3,
        minTotalAmount: 20000000,
        windowMs: 24 * 3600 * 1000
      };
    } else if (patternType === 'passthrough') {
      cypherQuery = CYPHER_PASSTHROUGH;
      params = {
        minSources: 3,
        minInAmount: 60000000,
        inWindowMs: 30 * 60 * 1000,
        outWindowMs: 30 * 60 * 1000,
        minOutRatio: 0.90
      };
    } else if (patternType === 'fanout') {
      cypherQuery = CYPHER_FANOUT;
      params = {
        minDestinations: 8,
        windowMs: 3600 * 1000
      };
    }

    const result = await session.executeRead(
      tx => tx.run(cypherQuery, params),
      { timeout: 5000 }
    );

    const execDurationMs = Date.now() - startTime;

    const items = result.records.map(rec => {
      if (patternType === 'structuring') {
        const fromAccount = rec.get('fromAccount');
        const toAccount = rec.get('toAccount');
        const txIds = rec.get('txIds');
        const txCount = Number(rec.get('txCount'));
        const totalAmount = Number(rec.get('totalAmount'));
        const spanMs = Number(rec.get('spanMs'));

        return {
          accounts: [fromAccount, toAccount],
          txIds,
          evidence: {
            fromAccount,
            toAccount,
            txCount,
            totalAmount,
            spanHours: Number((spanMs / 3600000).toFixed(1)),
            threshold: '< 10.000.000đ/giao dịch'
          },
          severity: 'HIGH'
        };
      }

      if (patternType === 'passthrough') {
        const midAccount = rec.get('midAccount');
        const srcAccounts = rec.get('srcAccounts');
        const dstAccounts = rec.get('dstAccounts');
        const inTxIds = rec.get('inTxIds') || [];
        const outTxIds = rec.get('outTxIds') || [];
        const totalIn = Number(rec.get('totalIn'));
        const totalOut = Number(rec.get('totalOut'));
        const passRatio = ((totalOut / totalIn) * 100).toFixed(1) + '%';

        return {
          accounts: [midAccount, ...srcAccounts, ...dstAccounts],
          txIds: [...inTxIds, ...outTxIds],
          evidence: {
            midAccount,
            sourceCount: srcAccounts.length,
            destCount: dstAccounts.length,
            totalIn,
            totalOut,
            passRatio
          },
          severity: 'HIGH'
        };
      }

      if (patternType === 'fanout') {
        const srcAccount = rec.get('srcAccount');
        const dstAccounts = rec.get('dstAccounts');
        const txIds = rec.get('txIds');
        const destCount = Number(rec.get('destCount'));
        const totalAmount = Number(rec.get('totalAmount'));
        const spanMs = Number(rec.get('spanMs'));

        return {
          accounts: [srcAccount, ...dstAccounts],
          txIds,
          evidence: {
            srcAccount,
            destCount,
            totalAmount,
            spanMinutes: Math.round(spanMs / 60000)
          },
          severity: 'HIGH'
        };
      }
    });

    return res.json({
      type: patternType,
      count: items.length,
      durationMs: execDurationMs,
      items
    });
  } catch (err) {
    const elapsed = Date.now() - startTime;
    if (elapsed >= 5000 || (err.message && (err.message.includes('timeout') || err.message.includes('TimedOut')))) {
      return res.status(504).json({ error: 'Truy vấn vượt quá thời gian tối đa 5000ms (Gateway Timeout)' });
    }
    console.error(`[GET /patterns?type=${patternType}] Lỗi:`, err.message);
    return res.status(500).json({ error: 'Lỗi thực thi truy vấn mẫu gian lận: ' + err.message });
  } finally {
    await session.close();
  }
});

/**
 * Trích xuất danh sách các toán tử trong kế hoạch thực thi (Plan Operators) từ profile
 */
function extractPlanOperators(profileObj) {
  if (!profileObj) return [];
  const list = [];
  function traverse(node) {
    if (!node) return;
    const operator = node.operatorType || node.operator || 'Unknown';
    const dbHits = Number(node.dbHits?.toNumber ? node.dbHits.toNumber() : node.dbHits) || 0;
    const rows = Number(node.rows?.toNumber ? node.rows.toNumber() : node.rows) || 0;
    list.push({ operator, dbHits, rows });
    if (Array.isArray(node.children)) {
      for (const child of node.children) {
        traverse(child);
      }
    }
  }
  traverse(profileObj);
  return list;
}

/**
 * GET /api/fraud/explain?query=cycles3|cyclesLong|structuring|passthrough|fanout
 * Endpoint Admin: Thực thi truy vấn PROFILE và trả về phân tích kế hoạch truy vấn
 * Yêu cầu quyền ADMIN hoặc ANALYST
 */
router.get('/explain', requireRole('ADMIN', 'ANALYST'), async (req, res) => {
  const { query } = req.query;
  const validQueries = ['cycles3', 'cyclesLong', 'structuring', 'passthrough', 'fanout'];

  if (!query || !validQueries.includes(query)) {
    return res.status(400).json({
      error: 'Tham số query không hợp lệ. Chỉ chấp nhận một trong các giá trị: cycles3, cyclesLong, structuring, passthrough, fanout'
    });
  }

  if (isUsingFallback() && process.env.ALLOW_FALLBACK_ANALYTICS !== 'true' && req.headers['x-allow-fallback'] !== 'true') {
    return res.status(503).json({ error: 'Cần Neo4j/Redis thật' });
  }

  const def = getQueryDefinition(query);
  if (!def) {
    return res.status(400).json({ error: 'Không tìm thấy định nghĩa câu truy vấn' });
  }

  const session = driver.session();
  const startTime = Date.now();
  try {
    const profileCypher = 'PROFILE ' + def.cypher;
    const result = await session.run(profileCypher, def.params);
    const durationMs = Math.max(1, Date.now() - startTime);

    const profileObj = result.summary && result.summary.profile;
    const plan = extractPlanOperators(profileObj);
    const totalDbHits = plan.reduce((sum, p) => sum + (p.dbHits || 0), 0);
    const rows = result.records ? result.records.length : 0;

    return res.json({
      query,
      name: def.name,
      cypher: def.cypher,
      durationMs,
      rows,
      dbHits: Math.max(1, totalDbHits),
      plan
    });
  } catch (err) {
    console.error(`[GET /explain?query=${query}] Lỗi:`, err.message);
    return res.status(500).json({ error: 'Lỗi thực thi PROFILE Cypher: ' + err.message });
  } finally {
    await session.close();
  }
});

module.exports = router;
