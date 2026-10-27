const request = require('supertest');
const app = require('../src/server');
const { resetTestData, cleanTestData, getAdminToken, DEMO_PASSWORD, redis } = require('./testHelper');

describe('Auth & Brute-force Tests', () => {
  beforeAll(async () => {
    await resetTestData();
  });

  afterAll(async () => {
    await cleanTestData();
  });

  test('5 wrong attempts trigger 429 lock with TTL <= 2s', async () => {
    const accountId = 'ACC022'; // Clean account not pre-locked in seed
    // 4 attempts return 401
    for (let i = 1; i <= 4; i++) {
      const res = await request(app)
        .post('/api/auth/login')
        .send({ accountId, password: 'WrongPassword!' });
      expect(res.status).toBe(401);
      expect(res.body.attempts).toBe(i);
      expect(res.body.locked).toBe(false);
    }

    // 5th attempt returns 429 and locks account
    const res5 = await request(app)
      .post('/api/auth/login')
      .send({ accountId, password: 'WrongPassword!' });
    expect(res5.status).toBe(429);
    expect(res5.body.locked).toBe(true);
    expect(res5.body.remainingSeconds).toBeLessThanOrEqual(2);

    // Verify Redis lock key exists and TTL <= 2s
    const ttl = await redis.ttl(`login:lock:${accountId}`);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(2);
  });

  test('After lock expiry, correct login succeeds and fail count resets to 0', async () => {
    const accountId = 'ACC022';
    // Wait for 2200ms for lock to expire
    await new Promise((r) => setTimeout(r, 2200));

    // Lock key should now be expired
    const lockVal = await redis.get(`login:lock:${accountId}`);
    expect(lockVal).toBeNull();

    // Login with correct password
    const res = await request(app)
      .post('/api/auth/login')
      .send({ accountId, password: DEMO_PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.token).toBeDefined();

    // Fail count should be 0/null
    const failCount = await redis.get(`login:fail:${accountId}`);
    expect(failCount).toBeNull();
  });

  test('Non-existent account returns 401 and increments fail counter in Redis', async () => {
    const nonExistentId = 'ACC999';
    const res = await request(app)
      .post('/api/auth/login')
      .send({ accountId: nonExistentId, password: 'AnyPassword' });

    expect(res.status).toBe(401);
    expect(res.body.attempts).toBe(1);

    const failCount = await redis.get(`login:fail:${nonExistentId}`);
    expect(Number(failCount)).toBe(1);
  });

  test('Missing Bearer token on POST /api/transactions returns 401', async () => {
    const res = await request(app)
      .post('/api/transactions')
      .send({
        fromAccountId: 'ACC001',
        toAccountId: 'ACC002',
        amount: 1000000,
        note: 'Test unauthorized transfer'
      });
    expect(res.status).toBe(401);
  });

  test('Missing or invalid role on admin routes returns 401/403', async () => {
    // Missing token
    const res1 = await request(app).get('/api/auth/admin/security-status');
    expect(res1.status).toBe(401);

    // Invalid token
    const res2 = await request(app)
      .get('/api/auth/admin/security-status')
      .set('Authorization', 'Bearer invalid_token');
    expect(res2.status).toBe(401);

    // Valid admin token
    const adminToken = await getAdminToken(app);
    const res3 = await request(app)
      .get('/api/auth/admin/security-status')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res3.status).toBe(200);
  });
});

