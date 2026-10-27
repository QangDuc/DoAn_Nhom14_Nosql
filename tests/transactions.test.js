const request = require('supertest');
const app = require('../src/server');
const { resetTestData, cleanTestData, DEMO_PASSWORD, redis, driver } = require('./testHelper');

describe('Transaction Processing & Concurrency Tests', () => {
  beforeAll(async () => {
    await resetTestData();
  });

  afterAll(async () => {
    await cleanTestData();
  });

  test('Self-transfer is rejected with 400', async () => {
    const fromId = 'ACC023';
    const loginRes = await request(app)
      .post('/api/auth/login')
      .send({ accountId: fromId, password: DEMO_PASSWORD });
    expect(loginRes.status).toBe(200);
    const token = loginRes.body.token;

    const res = await request(app)
      .post('/api/transactions')
      .set('Authorization', `Bearer ${token}`)
      .send({
        fromAccountId: fromId,
        toAccountId: fromId,
        amount: 500000,
        note: 'Self transfer test'
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/chính mình/i);
  });

  test('Insufficient balance is rejected with 400', async () => {
    const fromId = 'ACC023';
    const loginRes = await request(app)
      .post('/api/auth/login')
      .send({ accountId: fromId, password: DEMO_PASSWORD });
    expect(loginRes.status).toBe(200);
    const token = loginRes.body.token;

    const res = await request(app)
      .post('/api/transactions')
      .set('Authorization', `Bearer ${token}`)
      .send({
        fromAccountId: fromId,
        toAccountId: 'ACC024',
        amount: 999999999999, // Super high amount exceeding balance
        note: 'Overdraft attempt'
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/không đủ/i);
  });

  test('Transfer involving a closed account is rejected with 400', async () => {
    const session = driver.session();
    try {
      await session.run(
        `MATCH (a:Account {accountId: $accountId}) SET a.status = 'CLOSED' RETURN a`,
        { accountId: 'ACC025' }
      );
    } finally {
      await session.close();
    }

    const fromId = 'ACC024';
    const loginRes = await request(app)
      .post('/api/auth/login')
      .send({ accountId: fromId, password: DEMO_PASSWORD });
    expect(loginRes.status).toBe(200);
    const token = loginRes.body.token;

    const res = await request(app)
      .post('/api/transactions')
      .set('Authorization', `Bearer ${token}`)
      .send({
        fromAccountId: fromId,
        toAccountId: 'ACC025',
        amount: 1000000,
        note: 'Transfer to closed account'
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/CLOSED|đã bị đóng/i);
  });

  test('5 parallel transactions of 60% balance: exactly 1 succeeds and balance >= 0', async () => {
    const fromId = 'ACC026';
    const toId = 'ACC027';

    const loginRes = await request(app)
      .post('/api/auth/login')
      .send({ accountId: fromId, password: DEMO_PASSWORD });
    expect(loginRes.status).toBe(200);
    const token = loginRes.body.token;
    const initialBalance = loginRes.body.account.balance;
    const transferAmount = Math.floor(initialBalance * 0.6);

    // Launch 5 parallel transfers simultaneously
    const requests = Array.from({ length: 5 }, () =>
      request(app)
        .post('/api/transactions')
        .set('Authorization', `Bearer ${token}`)
        .send({
          fromAccountId: fromId,
          toAccountId: toId,
          amount: transferAmount,
          note: 'Parallel double-spend attempt'
        })
    );

    const responses = await Promise.all(requests);
    const successCount = responses.filter((r) => r.status === 201).length;
    const failedCount = responses.filter((r) => r.status === 400).length;

    expect(successCount).toBe(1);
    expect(failedCount).toBe(4);

    // Verify balance in database
    const session = driver.session();
    let finalBalance = 0;
    try {
      const result = await session.run(
        `MATCH (a:Account {accountId: $accountId}) RETURN a`,
        { accountId: fromId }
      );
      finalBalance = result.records[0].get('a').properties.balance;
    } finally {
      await session.close();
    }

    expect(finalBalance).toBe(initialBalance - transferAmount);
    expect(finalBalance).toBeGreaterThanOrEqual(0);
  });

  test('Transfer involving frozen account returns 423', async () => {
    const frozenId = 'ACC028';
    // Freeze account in Redis
    await redis.set(`account:frozen:${frozenId}`, 'BRUTE_FORCE', 'EX', 60);

    const loginRes = await request(app)
      .post('/api/auth/login')
      .send({ accountId: frozenId, password: DEMO_PASSWORD });
    expect(loginRes.status).toBe(200);
    const token = loginRes.body.token;

    const res = await request(app)
      .post('/api/transactions')
      .set('Authorization', `Bearer ${token}`)
      .send({
        fromAccountId: frozenId,
        toAccountId: 'ACC029',
        amount: 100000,
        note: 'Transfer from frozen'
      });

    expect(res.status).toBe(423);
    expect(res.body.frozenAccount).toBe(frozenId);
    expect(res.body.reason).toBe('BRUTE_FORCE');
  });
});

