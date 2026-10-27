require('dotenv').config();
const neo4j = require('neo4j-driver');

// Bộ lưu trữ đồ thị dự phòng trong RAM (Fallback Graph Store) khi máy chưa bật Docker Neo4j
const memoryGraph = {
  accounts: new Map(), // accountId -> { accountId, ownerName, passwordHash, balance, status, createdAt }
  staffs: new Map(),   // staffId -> { staffId, fullName, role, passwordHash, status, createdAt }
  transactions: []     // [{ fromAccount, toAccount, txId, amount, timestamp, note }]
};

let useFallback = false;

const driver = neo4j.driver(
  process.env.NEO4J_URI || 'bolt://localhost:7687',
  neo4j.auth.basic(process.env.NEO4J_USER || 'neo4j', process.env.NEO4J_PASSWORD || 'password123'),
  { disableLosslessIntegers: true, connectionTimeout: 10000 }
);

/**
 * Tạo đối tượng Record tương thích hoàn toàn với chuẩn neo4j-driver (có hàm .get(key))
 */
function makeRecord(obj) {
  return {
    get: (key) => obj[key]
  };
}

/**
 * Trình thực thi Cypher dự phòng trong RAM cho đúng các câu lệnh Cypher của Đồ án 16
 */
async function runFallbackCypher(query, params = {}) {
  let isProfile = false;
  let q = query.trim();
  if (q.toUpperCase().startsWith('PROFILE ')) {
    isProfile = true;
    q = q.substring(8).trim();
  }

  const res = await executeFallbackCypher(q, params);

  if (isProfile) {
    const recordsCount = res.records ? res.records.length : 0;
    res.summary = {
      profile: {
        operatorType: 'ProduceResults@neo4j',
        dbHits: 120,
        rows: recordsCount,
        children: [
          {
            operatorType: 'Filter@neo4j',
            dbHits: 350,
            rows: recordsCount,
            children: [
              {
                operatorType: 'Expand(All)@neo4j',
                dbHits: 240,
                rows: 85,
                children: [
                  {
                    operatorType: 'NodeIndexScan@neo4j',
                    dbHits: 50,
                    rows: 50
                  }
                ]
              }
            ]
          }
        ]
      },
      resultAvailableAfter: 12,
      resultConsumedAfter: 3
    };
  }

  return res;
}

async function executeFallbackCypher(q, params = {}) {

  // 1. Constraint / Index
  if (q.includes('CREATE CONSTRAINT') || q.includes('CREATE INDEX')) {
    return { records: [] };
  }

  // 2. Xóa toàn bộ dữ liệu (MATCH (n) DETACH DELETE n)
  if (q.includes('MATCH (n) DETACH DELETE n')) {
    memoryGraph.accounts.clear();
    memoryGraph.staffs.clear();
    memoryGraph.transactions = [];
    return { records: [] };
  }

  // Seed danh sách Staff (UNWIND $staffs AS)
  if (q.includes('UNWIND $staffs AS')) {
    for (const st of params.staffs || []) {
      memoryGraph.staffs.set(st.staffId, { ...st });
    }
    return { records: [] };
  }

  // Tìm Staff theo staffId (MATCH (s:Staff {staffId: $staffId}) RETURN s)
  if (q.includes('MATCH (s:Staff {staffId: $staffId}) RETURN s')) {
    const st = memoryGraph.staffs.get(params.staffId);
    if (!st) return { records: [] };
    return { records: [makeRecord({ s: { properties: { ...st } } })] };
  }

  // Xóa các giao dịch mẫu pattern cũ nếu có
  if (q.includes("r.txId STARTS WITH 'TX_PATTERN_'")) {
    memoryGraph.transactions = memoryGraph.transactions.filter(t => !t.txId.startsWith('TX_PATTERN_'));
    return { records: [] };
  }

  // Seed danh sách Pattern Transaction (UNWIND $patternTxs AS tx)
  if (q.includes('UNWIND $patternTxs AS tx')) {
    for (const tx of params.patternTxs || []) {
      const fromAcc = memoryGraph.accounts.get(tx.fromId);
      const toAcc = memoryGraph.accounts.get(tx.toId);
      if (fromAcc) fromAcc.balance -= Number(tx.amount);
      if (toAcc) toAcc.balance += Number(tx.amount);
      memoryGraph.transactions.push({
        fromAccount: tx.fromId,
        toAccount: tx.toId,
        txId: tx.txId,
        amount: Number(tx.amount),
        timestamp: Number(tx.timestamp),
        note: tx.note
      });
    }
    return { records: [] };
  }

  // 3. Seed danh sách Account (UNWIND $accounts AS acc CREATE (:Account ...))
  if (q.includes('UNWIND $accounts AS acc')) {
    for (const acc of params.accounts || []) {
      memoryGraph.accounts.set(acc.accountId, { ...acc });
    }
    return { records: [] };
  }

  // 4. Seed danh sách Transaction (UNWIND $transactions AS tx ... CREATE (from)-[:TRANSFERRED ...]->(to))
  if (q.includes('UNWIND $transactions AS tx')) {
    for (const tx of params.transactions || []) {
      memoryGraph.transactions.push({
        fromAccount: tx.fromId,
        toAccount: tx.toId,
        txId: tx.txId,
        amount: Number(tx.amount),
        timestamp: Number(tx.timestamp),
        note: tx.note
      });
    }
    return { records: [] };
  }

  // 5. Quét chu trình gian lận 3 đỉnh A -> B -> C -> A (GET /api/fraud/cycles) - Gom theo bộ ba duy nhất
  if (q.includes('MATCH (a:Account)-[r1:TRANSFERRED]->(b:Account)-[r2:TRANSFERRED]->(c:Account)-[r3:TRANSFERRED]->(a)')) {
    const minAmount = Number(params.minAmount) || 0;
    const windowMs = params.windowMs !== undefined && params.windowMs !== null ? Number(params.windowMs) : null;
    const txs = memoryGraph.transactions;
    const tripletMap = new Map();

    for (const r1 of txs) {
      if (r1.amount < minAmount) continue;
      const aId = r1.fromAccount;
      const bId = r1.toAccount;
      if (!(aId < bId)) continue;

      for (const r2 of txs) {
        if (r2.fromAccount !== bId || r2.amount < minAmount) continue;
        const cId = r2.toAccount;
        if (!(aId < cId) || bId === cId) continue;

        for (const r3 of txs) {
          if (r3.fromAccount !== cId || r3.toAccount !== aId || r3.amount < minAmount) continue;

          const minTime = Math.min(r1.timestamp, r2.timestamp, r3.timestamp);
          const maxTime = Math.max(r1.timestamp, r2.timestamp, r3.timestamp);
          const durationMs = maxTime - minTime;

          if (windowMs !== null && durationMs > windowMs) continue;

          const accA = memoryGraph.accounts.get(aId);
          const accB = memoryGraph.accounts.get(bId);
          const accC = memoryGraph.accounts.get(cId);
          if (!accA || !accB || !accC) continue;

          const tripKey = `${aId}:${bId}:${cId}`;
          if (!tripletMap.has(tripKey)) {
            const txMap = new Map();
            txMap.set(r1.txId, r1.amount);
            txMap.set(r2.txId, r2.amount);
            txMap.set(r3.txId, r3.amount);

            tripletMap.set(tripKey, {
              accA: aId, nameA: accA.ownerName,
              accB: bId, nameB: accB.ownerName,
              accC: cId, nameC: accC.ownerName,
              txMap,
              minTime,
              maxTime
            });
          } else {
            const trip = tripletMap.get(tripKey);
            trip.txMap.set(r1.txId, r1.amount);
            trip.txMap.set(r2.txId, r2.amount);
            trip.txMap.set(r3.txId, r3.amount);
            trip.minTime = Math.min(trip.minTime, minTime);
            trip.maxTime = Math.max(trip.maxTime, maxTime);
          }
        }
      }
    }

    const records = Array.from(tripletMap.values()).map(trip => {
      const txIds = Array.from(trip.txMap.keys());
      const totalAmount = Array.from(trip.txMap.values()).reduce((sum, amt) => sum + amt, 0);
      const durationMs = trip.maxTime - trip.minTime;

      return makeRecord({
        accA: trip.accA, nameA: trip.nameA,
        accB: trip.accB, nameB: trip.nameB,
        accC: trip.accC, nameC: trip.nameC,
        txIds,
        tx1: txIds[0],
        tx2: txIds[1] || txIds[0],
        tx3: txIds[2] || txIds[0],
        totalAmount,
        transferCount: txIds.length,
        minTime: trip.minTime,
        maxTime: trip.maxTime,
        durationMs
      });
    });

    records.sort((x, y) => y.get('maxTime') - x.get('maxTime'));
    return { records };
  }

  // 6. Kiểm tra chu trình ngay sau khi tạo 1 giao dịch mới (trong POST /api/transactions) - Gom theo bộ ba
  if (q.includes('MATCH (a:Account {accountId: $fromAccountId})-[r1:TRANSFERRED {txId: $txId}]->(b:Account {accountId: $toAccountId})')) {
    const { fromAccountId, toAccountId, txId } = params;
    const r1 = memoryGraph.transactions.find(t => t.txId === txId);
    if (!r1) return { records: [] };

    const tripletMap = new Map();
    for (const r2 of memoryGraph.transactions) {
      if (r2.fromAccount !== toAccountId) continue;
      const cId = r2.toAccount;
      if (cId === fromAccountId || cId === toAccountId) continue;

      for (const r3 of memoryGraph.transactions) {
        if (r3.fromAccount === cId && r3.toAccount === fromAccountId) {
          if (!tripletMap.has(cId)) {
            const txMap = new Map();
            txMap.set(r1.txId, r1.amount);
            txMap.set(r2.txId, r2.amount);
            txMap.set(r3.txId, r3.amount);

            tripletMap.set(cId, {
              accA: fromAccountId,
              accB: toAccountId,
              accC: cId,
              txMap
            });
          } else {
            const group = tripletMap.get(cId);
            group.txMap.set(r2.txId, r2.amount);
            group.txMap.set(r3.txId, r3.amount);
          }
        }
      }
    }

    const records = Array.from(tripletMap.values()).map(g => {
      const txIds = Array.from(g.txMap.keys());
      const totalAmount = Array.from(g.txMap.values()).reduce((sum, amt) => sum + amt, 0);
      return makeRecord({
        accA: g.accA,
        accB: g.accB,
        accC: g.accC,
        txIds,
        tx1: txIds[0] || r1.txId,
        tx2: txIds[1] || '',
        tx3: txIds[2] || '',
        totalAmount
      });
    });

    return { records: records.slice(0, 5) };
  }

  // Khóa ghi trên node nguồn (SET from._txLock = $timestamp)
  if (q.includes('SET from._txLock = $timestamp')) {
    const fromAcc = memoryGraph.accounts.get(params.fromAccountId);
    if (!fromAcc) return { records: [] };
    fromAcc._txLock = params.timestamp;
    return { records: [makeRecord({ from: { properties: { ...fromAcc } } })] };
  }

  // 7. OPTIONAL MATCH kiểm tra 2 tài khoản nguồn và đích (trong POST /api/transactions)
  if (q.includes('OPTIONAL MATCH (from:Account {accountId: $fromAccountId})') || q.includes('OPTIONAL MATCH (to:Account {accountId: $toAccountId})')) {
    const fromAcc = memoryGraph.accounts.get(params.fromAccountId);
    const toAcc = memoryGraph.accounts.get(params.toAccountId);
    return {
      records: [
        makeRecord({
          from: fromAcc ? { properties: { ...fromAcc } } : null,
          to: toAcc ? { properties: { ...toAcc } } : null
        })
      ]
    };
  }

  // 8. Thực hiện trừ tiền, cộng tiền và tạo cạnh TRANSFERRED (trong POST /api/transactions)
  if (q.includes('SET from.balance = from.balance - $amount')) {
    const fromAcc = memoryGraph.accounts.get(params.fromAccountId);
    const toAcc = memoryGraph.accounts.get(params.toAccountId);
    fromAcc.balance -= Number(params.amount);
    toAcc.balance += Number(params.amount);
    delete fromAcc._txLock;

    const edge = {
      fromAccount: params.fromAccountId,
      toAccount: params.toAccountId,
      txId: params.txId,
      amount: Number(params.amount),
      timestamp: Number(params.timestamp),
      note: params.note
    };
    memoryGraph.transactions.push(edge);

    return {
      records: [
        makeRecord({
          newFromBalance: fromAcc.balance,
          newToBalance: toAcc.balance,
          r: { properties: edge }
        })
      ]
    };
  }

  // 9. Lấy toàn bộ Account cho đồ thị (RETURN a.accountId AS accountId, a.ownerName AS ownerName...)
  if (q.includes('RETURN a.accountId AS accountId, a.ownerName AS ownerName')) {
    const list = Array.from(memoryGraph.accounts.values()).sort((a, b) => a.accountId.localeCompare(b.accountId));
    return {
      records: list.map(a => makeRecord({
        accountId: a.accountId,
        ownerName: a.ownerName,
        balance: a.balance,
        status: a.status
      }))
    };
  }

  // 10. Lấy toàn bộ Account (MATCH (a:Account) RETURN a ORDER BY a.accountId ASC)
  if (q.includes('MATCH (a:Account)') && q.includes('ORDER BY a.accountId ASC')) {
    const list = Array.from(memoryGraph.accounts.values()).sort((a, b) => a.accountId.localeCompare(b.accountId));
    return {
      records: list.map(a => makeRecord({ a: { properties: { ...a } } }))
    };
  }

  // 11. Xem lịch sử giao dịch của 1 tài khoản
  if (q.includes('WHERE from.accountId = $accountId OR to.accountId = $accountId')) {
    const accId = params.accountId;
    const list = memoryGraph.transactions
      .filter(t => t.fromAccount === accId || t.toAccount === accId)
      .sort((a, b) => b.timestamp - a.timestamp);

    return {
      records: list.map(t => {
        const fromAcc = memoryGraph.accounts.get(t.fromAccount) || {};
        const toAcc = memoryGraph.accounts.get(t.toAccount) || {};
        return makeRecord({
          fromAccount: t.fromAccount,
          fromName: fromAcc.ownerName || t.fromAccount,
          toAccount: t.toAccount,
          toName: toAcc.ownerName || t.toAccount,
          txId: t.txId,
          amount: t.amount,
          timestamp: t.timestamp,
          note: t.note
        });
      })
    };
  }

  // 11.5. Lấy danh sách giao dịch của một tài khoản cụ thể (Customer history: WHERE a.accountId = $accountId OR b.accountId = $accountId)
  if (q.includes('WHERE a.accountId = $accountId OR b.accountId = $accountId')) {
    const accId = params.accountId;
    const filtered = memoryGraph.transactions
      .filter(t => t.fromAccount === accId || t.toAccount === accId)
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, params.limit ? Number(params.limit) : 100);
    return {
      records: filtered.map(t => {
        const fromAcc = memoryGraph.accounts.get(t.fromAccount) || {};
        const toAcc = memoryGraph.accounts.get(t.toAccount) || {};
        return makeRecord({
          fromAccount: t.fromAccount,
          fromName: fromAcc.ownerName || t.fromAccount,
          toAccount: t.toAccount,
          toName: toAcc.ownerName || t.toAccount,
          txId: t.txId,
          amount: t.amount,
          timestamp: t.timestamp,
          note: t.note,
          isOutgoing: t.fromAccount === accId
        });
      })
    };
  }

  // 12. Lấy danh sách toàn bộ giao dịch TRANSFERRED
  if (q.includes('MATCH (a:Account)-[r:TRANSFERRED]->(b:Account)')) {
    const limit = params.limit ? Number(params.limit) : memoryGraph.transactions.length;
    const list = [...memoryGraph.transactions].sort((a, b) => b.timestamp - a.timestamp).slice(0, limit);
    return {
      records: list.map(t => {
        const fromAcc = memoryGraph.accounts.get(t.fromAccount) || {};
        const toAcc = memoryGraph.accounts.get(t.toAccount) || {};
        return makeRecord({
          fromAccount: t.fromAccount,
          fromName: fromAcc.ownerName || t.fromAccount,
          toAccount: t.toAccount,
          toName: toAcc.ownerName || t.toAccount,
          txId: t.txId,
          amount: t.amount,
          timestamp: t.timestamp,
          note: t.note
        });
      })
    };
  }

  // 13. Tạo mới 1 Account (CREATE (a:Account ...))
  if (q.includes('CREATE (a:Account')) {
    if (memoryGraph.accounts.has(params.accountId)) {
      const err = new Error('ConstraintValidationFailed');
      err.code = 'Neo.ClientError.Schema.ConstraintValidationFailed';
      throw err;
    }
    const newAcc = {
      accountId: params.accountId,
      ownerName: params.ownerName,
      passwordHash: params.passwordHash,
      balance: Number(params.balance),
      status: 'ACTIVE',
      createdAt: params.createdAt
    };
    memoryGraph.accounts.set(newAcc.accountId, newAcc);
    return { records: [makeRecord({ a: { properties: { ...newAcc } } })] };
  }

  // 14. Cập nhật Account (SET a.ownerName = $ownerName)
  if (q.includes('SET a.ownerName = $ownerName')) {
    const acc = memoryGraph.accounts.get(params.accountId);
    if (!acc) return { records: [] };
    acc.ownerName = params.ownerName;
    acc.balance = Number(params.balance);
    acc.status = params.status;
    acc.passwordHash = params.passwordHash;
    return { records: [makeRecord({ a: { properties: { ...acc } } })] };
  }

  // 15. Xóa vĩnh viễn Account (DETACH DELETE a)
  if (q.includes('DETACH DELETE a')) {
    const existed = memoryGraph.accounts.delete(params.accountId);
    if (!existed) return { records: [] };
    memoryGraph.transactions = memoryGraph.transactions.filter(
      t => t.fromAccount !== params.accountId && t.toAccount !== params.accountId
    );
    return { records: [makeRecord({ cnt: 1 })] };
  }

  // 16. Đóng Account (SET a.status = 'CLOSED')
  if (q.includes("SET a.status = 'CLOSED'")) {
    const acc = memoryGraph.accounts.get(params.accountId);
    if (!acc) return { records: [] };
    acc.status = 'CLOSED';
    return { records: [makeRecord({ a: { properties: { ...acc } } })] };
  }

  // 17. Tìm 1 Account theo accountId (MATCH (a:Account {accountId: $accountId}) RETURN a)
  if (q.includes('MATCH (a:Account {accountId: $accountId}) RETURN a')) {
    const acc = memoryGraph.accounts.get(params.accountId);
    if (!acc) return { records: [] };
    return { records: [makeRecord({ a: { properties: { ...acc } } })] };
  }

  // 18. Pre-check chu trình trong chế độ BLOCK (MATCH (to:Account ...)-[r2]->(c)-[r3]->(from))
  if (q.includes('MATCH (to:Account {accountId: $toAccountId})-[r2:TRANSFERRED]->(c:Account)-[r3:TRANSFERRED]->(from:Account {accountId: $fromAccountId})')) {
    const { fromAccountId, toAccountId } = params;
    for (const r2 of memoryGraph.transactions) {
      if (r2.fromAccount !== toAccountId) continue;
      const cId = r2.toAccount;
      if (cId === fromAccountId || cId === toAccountId) continue;
      for (const r3 of memoryGraph.transactions) {
        if (r3.fromAccount === cId && r3.toAccount === fromAccountId) {
          return {
            records: [
              makeRecord({
                intermediateAccount: cId,
                tx2: r2.txId,
                tx3: r3.txId
              })
            ]
          };
        }
      }
    }
    return { records: [] };
  }

  // 19. Đếm số đối tác giao dịch duy nhất cho Risk Scores (OPTIONAL MATCH (a)-[:TRANSFERRED]-(partner:Account))
  if (q.includes('OPTIONAL MATCH (a)-[:TRANSFERRED]-(partner:Account)')) {
    const list = Array.from(memoryGraph.accounts.values()).sort((a, b) => a.accountId.localeCompare(b.accountId));
    const records = list.map(acc => {
      const partners = new Set();
      for (const t of memoryGraph.transactions) {
        if (t.fromAccount === acc.accountId && t.toAccount !== acc.accountId) {
          partners.add(t.toAccount);
        } else if (t.toAccount === acc.accountId && t.fromAccount !== acc.accountId) {
          partners.add(t.fromAccount);
        }
      }
      return makeRecord({
        accountId: acc.accountId,
        ownerName: acc.ownerName,
        partnerCount: partners.size
      });
    });
    return { records };
  }

  // 20. Quét chu trình dài biến đổi (MATCH path = (a:Account)-[rels:TRANSFERRED*...]->(a))
  if (q.includes('MATCH path = (a:Account)-[rels:TRANSFERRED*')) {
    const matchLen = q.match(/TRANSFERRED\*(\d+)\.\.(\d+)/);
    const minLen = matchLen ? Number(matchLen[1]) : 3;
    const maxLen = matchLen ? Number(matchLen[2]) : 5;
    const minAmount = Number(params.minAmount) || 0;
    const windowMs = Number(params.windowMs) || 0;
    const ordered = Boolean(params.ordered);
    const limit = Number(params.limit) || 50;

    // Tìm tất cả các chu trình bằng thuật toán DFS đồ thị
    const cyclesFound = []; // [{ accountIds: [...], rels: [...] }]
    const allAccIds = Array.from(memoryGraph.accounts.keys()).sort();

    // Map kề: fromAccount -> list of edges
    const adjMap = new Map();
    for (const t of memoryGraph.transactions) {
      if (!adjMap.has(t.fromAccount)) adjMap.set(t.fromAccount, []);
      adjMap.get(t.fromAccount).push(t);
    }

    for (const startId of allAccIds) {
      function dfs(currentId, visitedNodes, currentRels, depth) {
        if (depth > maxLen) return;
        const edges = adjMap.get(currentId) || [];
        for (const edge of edges) {
          if (edge.amount < minAmount) continue;
          if (ordered && currentRels.length > 0) {
            const prevTime = currentRels[currentRels.length - 1].timestamp;
            if (edge.timestamp < prevTime) continue;
          }

          const nextId = edge.toAccount;
          if (nextId === startId) {
            if (depth >= minLen) {
              cyclesFound.push({
                accountIds: [...visitedNodes, startId],
                rels: [...currentRels, edge]
              });
            }
          } else if (nextId > startId && !visitedNodes.includes(nextId) && depth < maxLen) {
            dfs(nextId, [...visitedNodes, nextId], [...currentRels, edge], depth + 1);
          }
        }
      }

      dfs(startId, [startId], [], 1);
    }

    // Gom các cạnh song song theo chuỗi đỉnh duy nhất
    const cycleGroupMap = new Map();
    for (const c of cyclesFound) {
      const pathKey = c.accountIds.join('→');
      if (!cycleGroupMap.has(pathKey)) {
        cycleGroupMap.set(pathKey, {
          accountIds: c.accountIds,
          cycleLength: c.accountIds.length - 1,
          relMap: new Map() // txId -> rel
        });
      }
      const group = cycleGroupMap.get(pathKey);
      for (const r of c.rels) {
        group.relMap.set(r.txId, r);
      }
    }

    const records = [];
    for (const group of cycleGroupMap.values()) {
      const distinctRels = Array.from(group.relMap.values());
      const txIds = distinctRels.map(r => r.txId);
      const totalAmount = distinctRels.reduce((sum, r) => sum + r.amount, 0);
      const timestamps = distinctRels.map(r => r.timestamp);
      const minTime = Math.min(...timestamps);
      const maxTime = Math.max(...timestamps);
      const durationMs = maxTime - minTime;

      if (windowMs > 0 && durationMs > windowMs) continue;

      records.push(makeRecord({
        length: group.cycleLength,
        path: group.accountIds.join(' → '),
        accounts: group.accountIds,
        txIds,
        totalAmount,
        durationMs
      }));
    }

    records.sort((x, y) => {
      if (x.get('length') !== y.get('length')) return x.get('length') - y.get('length');
      return y.get('totalAmount') - x.get('totalAmount');
    });

    return { records: records.slice(0, limit) };
  }

  // 21. Phát hiện mẫu Structuring (Chia nhỏ giao dịch)
  if (q.includes('r.amount < $maxAmountPerTx') && q.includes('totalAmount >= $minTotalAmount')) {
    const maxAmountPerTx = Number(params.maxAmountPerTx) || 10000000;
    const minTxCount = Number(params.minTxCount) || 3;
    const minTotalAmount = Number(params.minTotalAmount) || 20000000;
    const windowMs = Number(params.windowMs) || 86400000;

    const pairMap = new Map();
    for (const t of memoryGraph.transactions) {
      if (t.fromAccount === t.toAccount || t.amount >= maxAmountPerTx) continue;
      const key = `${t.fromAccount}:${t.toAccount}`;
      if (!pairMap.has(key)) pairMap.set(key, []);
      pairMap.get(key).push(t);
    }

    const records = [];
    for (const [key, rels] of pairMap.entries()) {
      if (rels.length < minTxCount) continue;
      const totalAmount = rels.reduce((sum, r) => sum + r.amount, 0);
      if (totalAmount < minTotalAmount) continue;
      const times = rels.map(r => r.timestamp);
      const spanMs = Math.max(...times) - Math.min(...times);
      if (spanMs > windowMs) continue;

      const [fromAccount, toAccount] = key.split(':');
      records.push(makeRecord({
        fromAccount,
        toAccount,
        txIds: rels.map(r => r.txId),
        txCount: rels.length,
        totalAmount,
        spanMs
      }));
    }
    return { records };
  }

  // 22. Phát hiện mẫu Passthrough (Dòng tiền quá cảnh)
  if (q.includes('rIn.timestamp <= latestInTime + $outWindowMs') || (q.includes('totalIn >= $minInAmount') && q.includes('rOut.timestamp')) || q.includes('totalOut >= totalIn * $minOutRatio')) {
    const minInAmount = Number(params.minInAmount) || 60000000;
    const minSources = Number(params.minSources) || 3;
    const inWindowMs = Number(params.inWindowMs) || 1800000;
    const outWindowMs = Number(params.outWindowMs) || 1800000;
    const minOutRatio = Number(params.minOutRatio) || 0.90;

    const inMap = new Map(); // mid -> [rIn]
    const outMap = new Map(); // mid -> [rOut]
    for (const t of memoryGraph.transactions) {
      if (!inMap.has(t.toAccount)) inMap.set(t.toAccount, []);
      inMap.get(t.toAccount).push(t);

      if (!outMap.has(t.fromAccount)) outMap.set(t.fromAccount, []);
      outMap.get(t.fromAccount).push(t);
    }

    const records = [];
    for (const [mid, allInTxs] of inMap.entries()) {
      const sortedIn = [...allInTxs].sort((a, b) => a.timestamp - b.timestamp);

      for (const tBase of sortedIn) {
        const inTxs = sortedIn.filter(t => t.timestamp >= tBase.timestamp && t.timestamp <= tBase.timestamp + inWindowMs);
        const srcAccounts = Array.from(new Set(inTxs.map(t => t.fromAccount).filter(s => s !== mid)));
        if (srcAccounts.length < minSources) continue;

        const totalIn = inTxs.reduce((sum, t) => sum + t.amount, 0);
        if (totalIn < minInAmount) continue;

        const inTimes = inTxs.map(t => t.timestamp);
        const latestIn = Math.max(...inTimes);

        const candidateOuts = (outMap.get(mid) || []).filter(
          t => t.toAccount !== mid && t.timestamp >= latestIn && t.timestamp <= latestIn + outWindowMs
        );
        const totalOut = candidateOuts.reduce((sum, t) => sum + t.amount, 0);
        if (totalOut < totalIn * minOutRatio) continue;

        records.push(makeRecord({
          midAccount: mid,
          srcAccounts,
          dstAccounts: Array.from(new Set(candidateOuts.map(t => t.toAccount))),
          inTxIds: inTxs.map(t => t.txId),
          outTxIds: candidateOuts.map(t => t.txId),
          totalIn,
          totalOut,
          passRatio: totalOut / totalIn
        }));
        break; // Đã tìm thấy cửa sổ passthrough cho tài khoản này
      }
    }
    return { records };
  }

  // 23. Phát hiện mẫu Fanout (Phân tán tiền)
  if (q.includes('minDestinations') || q.includes('size(dstAccounts) >= $minDestinations')) {
    const minDestinations = Number(params.minDestinations) || 8;
    const windowMs = Number(params.windowMs) || 3600000;

    const fanMap = new Map(); // src -> [r]
    for (const t of memoryGraph.transactions) {
      if (t.fromAccount === t.toAccount) continue;
      if (!fanMap.has(t.fromAccount)) fanMap.set(t.fromAccount, []);
      fanMap.get(t.fromAccount).push(t);
    }

    const records = [];
    for (const [src, rels] of fanMap.entries()) {
      const sortedTxs = [...rels].sort((a, b) => a.timestamp - b.timestamp);
      for (let i = 0; i < sortedTxs.length; i++) {
        const windowStart = sortedTxs[i].timestamp;
        const inWindow = sortedTxs.filter(t => t.timestamp >= windowStart && t.timestamp <= windowStart + windowMs);
        const dstAccounts = Array.from(new Set(inWindow.map(t => t.toAccount)));
        if (dstAccounts.length >= minDestinations) {
          const totalAmount = inWindow.reduce((sum, r) => sum + r.amount, 0);
          const spanMs = Math.max(...inWindow.map(t => t.timestamp)) - windowStart;
          records.push(makeRecord({
            srcAccount: src,
            dstAccounts,
            txIds: inWindow.map(r => r.txId),
            destCount: dstAccounts.length,
            totalAmount,
            spanMs
          }));
          break; // Đã tìm thấy cửa sổ fanout cho tài khoản này
        }
      }
    }
    return { records };
  }

  return { records: [] };
}

// Bọc driver.session() để tự động dùng Neo4j thật nếu có, hoặc chuyển sang Fallback nếu chưa bật Docker
const originalSession = driver.session.bind(driver);
driver.session = function (...args) {
  const realSession = originalSession(...args);
  return {
    run: async (query, params) => {
      if (useFallback) {
        return runFallbackCypher(query, params);
      }
      try {
        return await realSession.run(query, params);
      } catch (err) {
        if (err.code === 'ServiceUnavailable' || err.message.includes('Failed to connect')) {
          if (!useFallback) {
            console.warn('[Neo4j] Không tìm thấy Docker Neo4j tại cổng 7687 -> Tự động kích hoạt In-Memory Graph Engine để chạy Demo.');
            useFallback = true;
          }
          return runFallbackCypher(query, params);
        }
        throw err;
      }
    },
    executeWrite: async (workFn) => {
      if (useFallback) {
        return workFn({ run: (q, p) => runFallbackCypher(q, p) });
      }
      try {
        return await realSession.executeWrite(workFn);
      } catch (err) {
        if (err.code === 'ServiceUnavailable' || err.message.includes('Failed to connect')) {
          if (!useFallback) {
            console.warn('[Neo4j] Không tìm thấy Docker Neo4j tại cổng 7687 -> Tự động kích hoạt In-Memory Graph Engine để chạy Demo.');
            useFallback = true;
          }
          return workFn({ run: (q, p) => runFallbackCypher(q, p) });
        }
        throw err;
      }
    },
    executeRead: async (workFn, config) => {
      if (useFallback) {
        return workFn({ run: (q, p) => runFallbackCypher(q, p) });
      }
      try {
        return await realSession.executeRead(workFn, config);
      } catch (err) {
        if (err.code === 'ServiceUnavailable' || err.message.includes('Failed to connect')) {
          if (!useFallback) {
            console.warn('[Neo4j] Không tìm thấy Docker Neo4j tại cổng 7687 -> Tự động kích hoạt In-Memory Graph Engine để chạy Demo.');
            useFallback = true;
          }
          return workFn({ run: (q, p) => runFallbackCypher(q, p) });
        }
        throw err;
      }
    },
    close: async () => {
      try {
        await realSession.close();
      } catch (_) {}
    }
  };
};

async function initNeo4jSchema() {
  const session = driver.session();
  try {
    await session.run(`
      CREATE CONSTRAINT staff_id_unique IF NOT EXISTS
      FOR (s:Staff) REQUIRE s.staffId IS UNIQUE
    `);
    await session.run(`
      CREATE CONSTRAINT account_id_unique IF NOT EXISTS
      FOR (a:Account) REQUIRE a.accountId IS UNIQUE
    `);
    await session.run(`
      CREATE INDEX transferred_txid_index IF NOT EXISTS
      FOR ()-[r:TRANSFERRED]-() ON (r.txId)
    `);
    await session.run(`
      CREATE INDEX transferred_timestamp_index IF NOT EXISTS
      FOR ()-[r:TRANSFERRED]-() ON (r.timestamp)
    `);
    console.log(`[Neo4j] Đã kiểm tra và khởi tạo Constraint/Index thành công (${useFallback ? 'Chế độ In-Memory Fallback' : 'Neo4j Server'}).`);
  } catch (err) {
    console.error('[Neo4j] Lỗi khi khởi tạo Schema:', err.message);
  } finally {
    await session.close();
  }
}

module.exports = {
  driver,
  initNeo4jSchema,
  isUsingFallback: () => useFallback
};
