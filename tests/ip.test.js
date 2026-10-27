const request = require('supertest');
const app = require('../src/server');
const { resetTestData, cleanTestData, DEMO_PASSWORD, redis } = require('./testHelper');

describe('IP-based Brute-force & Blocking Tests', () => {
  beforeAll(async () => {
    await resetTestData();
  });

  afterAll(async () => {
    await cleanTestData();
  });

  test('5 wrong logins across 5 accounts from same x-demo-ip triggers IP block', async () => {
    const attackerIp = '192.168.88.99';
    const accounts = ['ACC031', 'ACC032', 'ACC033', 'ACC034', 'ACC035'];

    // First 4 attempts on 4 different accounts
    for (let i = 0; i < 4; i++) {
      const res = await request(app)
        .post('/api/auth/login')
        .set('x-demo-ip', attackerIp)
        .send({ accountId: accounts[i], password: 'WrongPassword' });
      expect(res.status).toBe(401);
      expect(res.body.locked).toBe(false);
    }

    // 5th attempt on 5th distinct account reaches IP_MAX_ACCOUNTS (5) -> triggers IP block
    const res5 = await request(app)
      .post('/api/auth/login')
      .set('x-demo-ip', attackerIp)
      .send({ accountId: accounts[4], password: 'WrongPassword' });
    expect(res5.status).toBe(429);
    expect(res5.body.scope).toBe('ip');
    expect(res5.body.blocked).toBe(true);

    // Subsequent request from same IP is immediately rejected with 429 scope=ip
    const blockedRes = await request(app)
      .post('/api/auth/login')
      .set('x-demo-ip', attackerIp)
      .send({ accountId: 'ACC001', password: DEMO_PASSWORD });
    expect(blockedRes.status).toBe(429);
    expect(blockedRes.body.scope).toBe('ip');
  });

  test('A clean IP remains completely unaffected', async () => {
    const cleanIp = '10.0.0.55';
    const res = await request(app)
      .post('/api/auth/login')
      .set('x-demo-ip', cleanIp)
      .send({ accountId: 'ACC001', password: DEMO_PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.token).toBeDefined();
  });
});

