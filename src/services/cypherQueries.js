/**
 * Định nghĩa tập trung các câu truy vấn Cypher phân tích gian lận (Neo4j)
 * Dùng chung cho cả endpoint nghiệp vụ (/api/fraud/...) và endpoint giải thích (/api/fraud/explain)
 */

const CYPHER_CYCLES_3 = `
MATCH (a:Account)-[r1:TRANSFERRED]->(b:Account)-[r2:TRANSFERRED]->(c:Account)-[r3:TRANSFERRED]->(a)
WHERE a.accountId < b.accountId
  AND a.accountId < c.accountId
  AND b.accountId <> c.accountId
  AND r1.amount >= $minAmount
  AND r2.amount >= $minAmount
  AND r3.amount >= $minAmount
WITH a, b, c, r1, r2, r3,
     CASE
       WHEN r1.timestamp <= r2.timestamp AND r1.timestamp <= r3.timestamp THEN r1.timestamp
       WHEN r2.timestamp <= r1.timestamp AND r2.timestamp <= r3.timestamp THEN r2.timestamp
       ELSE r3.timestamp
     END AS minTime,
     CASE
       WHEN r1.timestamp >= r2.timestamp AND r1.timestamp >= r3.timestamp THEN r1.timestamp
       WHEN r2.timestamp >= r1.timestamp AND r2.timestamp >= r3.timestamp THEN r2.timestamp
       ELSE r3.timestamp
     END AS maxTime
WHERE $windowMs IS NULL OR (maxTime - minTime) <= $windowMs
WITH a, b, c,
     collect(DISTINCT r1) AS rels1,
     collect(DISTINCT r2) AS rels2,
     collect(DISTINCT r3) AS rels3,
     min(minTime) AS minTime,
     max(maxTime) AS maxTime
WITH a, b, c, (rels1 + rels2 + rels3) AS allRels, minTime, maxTime
WITH a, b, c, allRels, minTime, maxTime,
     [r IN allRels | r.txId] AS txIds,
     reduce(total = 0, r IN allRels | total + r.amount) AS totalAmount,
     size(allRels) AS transferCount,
     (maxTime - minTime) AS durationMs
RETURN a.accountId AS accA, a.ownerName AS nameA,
       b.accountId AS accB, b.ownerName AS nameB,
       c.accountId AS accC, c.ownerName AS nameC,
       txIds, totalAmount, transferCount,
       minTime, maxTime, durationMs
ORDER BY maxTime DESC
`.trim();

function getCypherCyclesLong(minLen = 3, maxLen = 5) {
  return `
MATCH path = (a:Account)-[rels:TRANSFERRED*${minLen}..${maxLen}]->(a)
WHERE ALL(i IN range(0, size(nodes(path)) - 2) WHERE 
        ALL(j IN range(i + 1, size(nodes(path)) - 2) WHERE 
          nodes(path)[i] <> nodes(path)[j]))
  AND ALL(n IN nodes(path)[1..-1] WHERE a.accountId < n.accountId)
  AND ($minAmount = 0 OR ALL(r IN rels WHERE r.amount >= $minAmount))
  AND ($ordered = false OR ALL(i IN range(0, size(rels) - 2) WHERE rels[i].timestamp <= rels[i + 1].timestamp))
WITH path, a, rels,
     [n IN nodes(path) | n.accountId] AS accountIds
WITH accountIds,
     size(accountIds) - 1 AS cycleLength,
     collect(rels) AS allRelLists
WITH cycleLength,
     accountIds,
     reduce(all = [], rList IN allRelLists | all + [r IN rList WHERE NOT r IN all]) AS distinctRels
WITH cycleLength,
     accountIds,
     [r IN distinctRels | r.txId] AS txIds,
     reduce(total = 0, r IN distinctRels | total + r.amount) AS totalAmount,
     [r IN distinctRels | r.timestamp] AS allTimestamps
WITH cycleLength,
     accountIds,
     txIds,
     totalAmount,
     reduce(mx = allTimestamps[0], t IN allTimestamps | CASE WHEN t > mx THEN t ELSE mx END) -
     reduce(mn = allTimestamps[0], t IN allTimestamps | CASE WHEN t < mn THEN t ELSE mn END) AS durationMs
WHERE ($windowMs = 0 OR durationMs <= $windowMs)
RETURN cycleLength AS length,
       reduce(s = '', i IN range(0, size(accountIds) - 1) | 
         CASE WHEN i = 0 THEN accountIds[i] ELSE s + ' → ' + accountIds[i] END) AS path,
       accountIds AS accounts,
       txIds,
       totalAmount,
       durationMs
ORDER BY length ASC, totalAmount DESC
LIMIT $limit
`.trim();
}

const CYPHER_STRUCTURING = `
MATCH (from:Account)-[r:TRANSFERRED]->(to:Account)
WHERE from <> to AND r.amount < $maxAmountPerTx
WITH from, to, collect(r) AS allRels
WHERE size(allRels) >= $minTxCount
WITH from, to, allRels,
     [r IN allRels | r.timestamp] AS timestamps,
     reduce(total = 0, r IN allRels | total + r.amount) AS totalAmount
WITH from, to, allRels, totalAmount,
     reduce(mx = timestamps[0], t IN timestamps | CASE WHEN t > mx THEN t ELSE mx END) -
     reduce(mn = timestamps[0], t IN timestamps | CASE WHEN t < mn THEN t ELSE mn END) AS spanMs
WHERE totalAmount >= $minTotalAmount AND spanMs <= $windowMs
RETURN from.accountId AS fromAccount,
       to.accountId AS toAccount,
       [r IN allRels | r.txId] AS txIds,
       size(allRels) AS txCount,
       totalAmount,
       spanMs
ORDER BY totalAmount DESC
`.trim();

const CYPHER_PASSTHROUGH = `
MATCH (srcBase:Account)-[rInBase:TRANSFERRED]->(mid:Account)
WHERE srcBase <> mid
MATCH (src:Account)-[rIn:TRANSFERRED]->(mid)
WHERE src <> mid
  AND rIn.timestamp >= rInBase.timestamp
  AND rIn.timestamp <= rInBase.timestamp + $inWindowMs
WITH mid, rInBase.timestamp AS windowInStart,
     collect(DISTINCT src.accountId) AS srcAccounts,
     collect(rIn) AS inRels
WHERE size(srcAccounts) >= $minSources
WITH mid, windowInStart, srcAccounts, inRels,
     reduce(totIn = 0, r IN inRels | totIn + r.amount) AS totalIn,
     [r IN inRels | r.timestamp] AS inTimes
WITH mid, windowInStart, srcAccounts, inRels, totalIn,
     reduce(mx = inTimes[0], t IN inTimes | CASE WHEN t > mx THEN t ELSE mx END) AS latestInTime
WHERE totalIn >= $minInAmount
MATCH (mid)-[rOut:TRANSFERRED]->(dst:Account)
WHERE dst <> mid 
  AND rOut.timestamp >= latestInTime 
  AND rOut.timestamp <= latestInTime + $outWindowMs
WITH mid, srcAccounts, inRels, totalIn, latestInTime,
     collect(rOut) AS outRels, collect(DISTINCT dst.accountId) AS dstAccounts
WITH mid, srcAccounts, dstAccounts, inRels, outRels, totalIn,
     reduce(totOut = 0, r IN outRels | totOut + r.amount) AS totalOut
WHERE totalOut >= totalIn * $minOutRatio
RETURN DISTINCT mid.accountId AS midAccount,
       srcAccounts,
       dstAccounts,
       [r IN inRels | r.txId] AS inTxIds,
       [r IN outRels | r.txId] AS outTxIds,
       totalIn,
       totalOut
`.trim();

const CYPHER_FANOUT = `
MATCH (src:Account)-[r1:TRANSFERRED]->(d1:Account)
WHERE src <> d1
MATCH (src)-[r2:TRANSFERRED]->(d2:Account)
WHERE src <> d2 
  AND r2.timestamp >= r1.timestamp 
  AND r2.timestamp <= r1.timestamp + $windowMs
WITH src, r1.timestamp AS windowStart, 
     collect(DISTINCT d2.accountId) AS dstAccounts, 
     collect(r2) AS windowRels
WHERE size(dstAccounts) >= $minDestinations
WITH src, windowStart, dstAccounts, windowRels,
     [r IN windowRels | r.timestamp] AS timestamps,
     reduce(tot = 0, r IN windowRels | tot + r.amount) AS totalAmount
WITH src, windowStart, dstAccounts, windowRels, totalAmount,
     reduce(mx = timestamps[0], t IN timestamps | CASE WHEN t > mx THEN t ELSE mx END) - windowStart AS spanMs
RETURN src.accountId AS srcAccount,
       dstAccounts,
       [r IN windowRels | r.txId] AS txIds,
       size(dstAccounts) AS destCount,
       totalAmount,
       spanMs
ORDER BY destCount DESC, totalAmount DESC
LIMIT 10
`.trim();

/**
 * Trả về thông tin câu truy vấn và tham số mặc định cho từng loại query
 */
function getQueryDefinition(key) {
  switch (key) {
    case 'cycles3':
      return {
        key: 'cycles3',
        name: 'Chu trình khép kín 3 đỉnh (A → B → C → A)',
        cypher: CYPHER_CYCLES_3,
        params: { minAmount: 0, windowMs: null }
      };
    case 'cyclesLong':
      return {
        key: 'cyclesLong',
        name: 'Chu trình khép kín độ dài biến đổi (3 đến 5 đỉnh)',
        cypher: getCypherCyclesLong(3, 5),
        params: { minAmount: 0, ordered: false, windowMs: 0, limit: 50 }
      };
    case 'structuring':
      return {
        key: 'structuring',
        name: 'Chia nhỏ giao dịch (Structuring)',
        cypher: CYPHER_STRUCTURING,
        params: {
          maxAmountPerTx: 10000000,
          minTxCount: 3,
          minTotalAmount: 20000000,
          windowMs: 24 * 3600 * 1000
        }
      };
    case 'passthrough':
      return {
        key: 'passthrough',
        name: 'Dòng tiền quá cảnh (Pass-through Account)',
        cypher: CYPHER_PASSTHROUGH,
        params: {
          minSources: 3,
          minInAmount: 60000000,
          inWindowMs: 30 * 60 * 1000,
          outWindowMs: 30 * 60 * 1000,
          minOutRatio: 0.90
        }
      };
    case 'fanout':
      return {
        key: 'fanout',
        name: 'Phân tán dòng tiền thần tốc (Fan-out)',
        cypher: CYPHER_FANOUT,
        params: {
          minDestinations: 8,
          windowMs: 3600 * 1000
        }
      };
    default:
      return null;
  }
}

module.exports = {
  CYPHER_CYCLES_3,
  getCypherCyclesLong,
  CYPHER_STRUCTURING,
  CYPHER_PASSTHROUGH,
  CYPHER_FANOUT,
  getQueryDefinition
};

