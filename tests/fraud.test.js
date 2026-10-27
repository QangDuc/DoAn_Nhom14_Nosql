const request = require('supertest');
const app = require('../src/server');
const { resetTestData, cleanTestData, getAdminToken, DEMO_PASSWORD, driver } = require('./testHelper');

describe('Fraud Detection & Cycle Analysis Tests', () => {
  beforeAll(async () => {
    await resetTestData();
  });

  afterAll(async () => {
    await cleanTestData();
  });

  test('Fresh seed returns exactly 3 cycles', async () => {
    const res = await request(app).get('/api/fraud/cycles');
    expect(res.status).toBe(200);
    expect(res.body.summary.cycleCount).toBe(3);
    expect(res.body.cycles).toHaveLength(3);
  });

  test('Creating ACC030->ACC031->ACC032->ACC030 twice still yields 4 cycles (no duplicates)', async () => {
    const session = driver.session();
    const now = Date.now();
    try {
      const set1 = [
        { fromId: 'ACC030', toId: 'ACC031', txId: 'TX_CYC4_1', amount: 5000000, timestamp: now - 3000, note: 'Edge 1' },
        { fromId: 'ACC031', toId: 'ACC032', txId: 'TX_CYC4_2', amount: 5000000, timestamp: now - 2000, note: 'Edge 2' },
        { fromId: 'ACC032', toId: 'ACC030', txId: 'TX_CYC4_3', amount: 5000000, timestamp: now - 1000, note: 'Edge 3' }
      ];
      await session.run(`
        UNWIND $transactions AS tx
        MATCH (from:Account {accountId: tx.fromId})
        MATCH (to:Account {accountId: tx.toId})
        CREATE (from)-[r:TRANSFERRED {
          txId: tx.txId,
          amount: tx.amount,
          timestamp: tx.timestamp,
          note: tx.note
        }]->(to)
      `, { transactions: set1 });

      const set2 = [
        { fromId: 'ACC030', toId: 'ACC031', txId: 'TX_CYC4_1_DUP', amount: 6000000, timestamp: now - 900, note: 'Edge 1 Dup' },
        { fromId: 'ACC031', toId: 'ACC032', txId: 'TX_CYC4_2_DUP', amount: 6000000, timestamp: now - 800, note: 'Edge 2 Dup' },
        { fromId: 'ACC032', toId: 'ACC030', txId: 'TX_CYC4_3_DUP', amount: 6000000, timestamp: now - 700, note: 'Edge 3 Dup' }
      ];
      await session.run(`
        UNWIND $transactions AS tx
        MATCH (from:Account {accountId: tx.fromId})
        MATCH (to:Account {accountId: tx.toId})
        CREATE (from)-[r:TRANSFERRED {
          txId: tx.txId,
          amount: tx.amount,
          timestamp: tx.timestamp,
          note: tx.note
        }]->(to)
      `, { transactions: set2 });
    } finally {
      await session.close();
    }

    const res = await request(app).get('/api/fraud/cycles');
    expect(res.status).toBe(200);
    // Cycle count increases by exactly 1 (3 -> 4), no duplicate rows for the triplet
    expect(res.body.summary.cycleCount).toBe(4);
    expect(res.body.cycles).toHaveLength(4);

    // Find the cycle of ACC030
    const newCycle = res.body.cycles.find((c) => c.path.includes('ACC030'));
    expect(newCycle).toBeDefined();
    expect(newCycle.txIds.length).toBeGreaterThanOrEqual(6);
  });

  test('BLOCK mode returns 409 and balances are unchanged when completing cycle', async () => {
    const adminToken = await getAdminToken(app);

    // 1. Switch security mode to BLOCK
    const modeRes = await request(app)
      .put('/api/security/mode')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ mode: 'BLOCK' });
    expect(modeRes.status).toBe(200);

    // 2. Prepare 2 edges: ACC028 -> ACC029 and ACC029 -> ACC027
    const session = driver.session();
    const now = Date.now();
    try {
      const blockTxs = [
        { fromId: 'ACC028', toId: 'ACC029', txId: 'TX_BLOCK_1', amount: 2000000, timestamp: now - 2000, note: 'Step 1' },
        { fromId: 'ACC029', toId: 'ACC027', txId: 'TX_BLOCK_2', amount: 2000000, timestamp: now - 1000, note: 'Step 2' }
      ];
      await session.run(`
        UNWIND $transactions AS tx
        MATCH (from:Account {accountId: tx.fromId})
        MATCH (to:Account {accountId: tx.toId})
        CREATE (from)-[r:TRANSFERRED {
          txId: tx.txId,
          amount: tx.amount,
          timestamp: tx.timestamp,
          note: tx.note
        }]->(to)
      `, { transactions: blockTxs });
    } finally {
      await session.close();
    }

    // Login ACC027
    const loginRes = await request(app)
      .post('/api/auth/login')
      .send({ accountId: 'ACC027', password: DEMO_PASSWORD });
    expect(loginRes.status).toBe(200);
    const token = loginRes.body.token;
    const initialBal27 = loginRes.body.account.balance;

    // 3. Attempt completing cycle: ACC027 -> ACC028
    const blockAttempt = await request(app)
      .post('/api/transactions')
      .set('Authorization', `Bearer ${token}`)
      .send({
        fromAccountId: 'ACC027',
        toAccountId: 'ACC028',
        amount: 2000000,
        note: 'Closing cycle in BLOCK mode'
      });

    expect(blockAttempt.status).toBe(409);
    expect(blockAttempt.body.blocked).toBe(true);

    // Verify balance of ACC027 is unchanged
    const session2 = driver.session();
    try {
      const checkRes = await session2.run(
        `MATCH (a:Account {accountId: $accountId}) RETURN a`,
        { accountId: 'ACC027' }
      );
      const currentBal27 = checkRes.records[0].get('a').properties.balance;
      expect(currentBal27).toBe(initialBal27);
    } finally {
      await session2.close();
    }

    // Reset mode back to ALERT
    await request(app)
      .put('/api/security/mode')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ mode: 'ALERT' });
  });

  test('/cycles/long?minLen=3&maxLen=3 matches /cycles count', async () => {
    const adminToken = await getAdminToken(app);
    const cyclesRes = await request(app)
      .get('/api/fraud/cycles')
      .set('Authorization', `Bearer ${adminToken}`);
    const expectedCount = cyclesRes.body.summary.cycleCount;

    const longRes = await request(app)
      .get('/api/fraud/cycles/long?minLen=3&maxLen=3')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(longRes.status).toBe(200);
    expect(longRes.body.count).toBe(expectedCount);
  });

  test('4-node cycle is detected by /cycles/long?minLen=4&maxLen=4', async () => {
    // Create a 4-node cycle: ACC045 -> ACC046 -> ACC047 -> ACC048 -> ACC045
    const session = driver.session();
    const now = Date.now();
    try {
      const len4Txs = [
        { fromId: 'ACC045', toId: 'ACC046', txId: 'TX_LEN4_1', amount: 3000000, timestamp: now - 4000, note: 'Len4 1' },
        { fromId: 'ACC046', toId: 'ACC047', txId: 'TX_LEN4_2', amount: 3000000, timestamp: now - 3000, note: 'Len4 2' },
        { fromId: 'ACC047', toId: 'ACC048', txId: 'TX_LEN4_3', amount: 3000000, timestamp: now - 2000, note: 'Len4 3' },
        { fromId: 'ACC048', toId: 'ACC045', txId: 'TX_LEN4_4', amount: 3000000, timestamp: now - 1000, note: 'Len4 4' }
      ];
      await session.run(`
        UNWIND $transactions AS tx
        MATCH (from:Account {accountId: tx.fromId})
        MATCH (to:Account {accountId: tx.toId})
        CREATE (from)-[r:TRANSFERRED {
          txId: tx.txId,
          amount: tx.amount,
          timestamp: tx.timestamp,
          note: tx.note
        }]->(to)
      `, { transactions: len4Txs });
    } finally {
      await session.close();
    }

    const adminToken = await getAdminToken(app);

    const res = await request(app)
      .get('/api/fraud/cycles/long?minLen=4&maxLen=4')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.count).toBeGreaterThanOrEqual(1);
    const found = res.body.cycles.find((c) => c.accounts.includes('ACC045') && c.accounts.includes('ACC048'));
    expect(found).toBeDefined();
    expect(found.length).toBe(4);
  });

  test('3 patterns after seed-patterns each return >= 1 item', async () => {
    const adminToken = await getAdminToken(app);

    // 1. Seed patterns
    const seedRes = await request(app)
      .post('/api/admin/seed-patterns')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(seedRes.status).toBe(200);

    // 2. Structuring
    const structRes = await request(app)
      .get('/api/fraud/patterns?type=structuring')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(structRes.status).toBe(200);
    expect(structRes.body.count).toBeGreaterThanOrEqual(1);

    // 3. Passthrough
    const passRes = await request(app)
      .get('/api/fraud/patterns?type=passthrough')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(passRes.status).toBe(200);
    expect(passRes.body.count).toBeGreaterThanOrEqual(1);

    // 4. Fanout
    const fanRes = await request(app)
      .get('/api/fraud/patterns?type=fanout')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(fanRes.status).toBe(200);
    expect(fanRes.body.count).toBeGreaterThanOrEqual(1);
  });
});

