const request = require('supertest');
const app = require('../src/server');
const { resetTestData, cleanTestData, getAdminToken } = require('./testHelper');

describe('Security Events Stream Tests', () => {
  beforeAll(async () => {
    await resetTestData();
  });

  afterAll(async () => {
    await cleanTestData();
  });

  test('5 failed logins publish 5 LOGIN_FAIL events and 1 ACCOUNT_LOCKED event to Redis Stream', async () => {
    const targetAccount = 'ACC050';

    // 5 failed login attempts
    for (let i = 1; i <= 5; i++) {
      await request(app)
        .post('/api/auth/login')
        .send({ accountId: targetAccount, password: 'WrongPassword' });
    }

    const adminToken = await getAdminToken(app);

    // Query events via GET /api/events
    const res = await request(app)
      .get('/api/events?limit=100')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.events).toBeDefined();

    // Filter events relating to targetAccount
    const accEvents = res.body.events.filter((e) => e.accountId === targetAccount);
    const loginFailEvents = accEvents.filter((e) => e.type === 'LOGIN_FAIL');
    const accountLockedEvents = accEvents.filter((e) => e.type === 'ACCOUNT_LOCKED');

    expect(loginFailEvents.length).toBe(5);
    expect(accountLockedEvents.length).toBe(1);
  });
});

