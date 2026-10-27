const request = require('supertest');
const app = require('../src/server');
const { resetTestData, cleanTestData, getAdminToken, DEMO_PASSWORD } = require('./testHelper');

describe('Session Management Tests', () => {
  beforeAll(async () => {
    await resetTestData();
  });

  afterAll(async () => {
    await cleanTestData();
  });

  test('Login creates session and /api/auth/me returns user info', async () => {
    const loginRes = await request(app)
      .post('/api/auth/login')
      .send({ accountId: 'ACC002', password: DEMO_PASSWORD });
    expect(loginRes.status).toBe(200);
    const token = loginRes.body.token;
    expect(token).toBeDefined();

    const meRes = await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${token}`);
    expect(meRes.status).toBe(200);
    expect(meRes.body.accountId).toBe('ACC002');
  });

  test('Admin revoking session invalidates token', async () => {
    // 1. Login to get token
    const loginRes = await request(app)
      .post('/api/auth/login')
      .send({ accountId: 'ACC003', password: DEMO_PASSWORD });
    const token = loginRes.body.token;
    const sessionId = token.substring(0, 8);

    const adminToken = await getAdminToken(app);

    // 2. Admin revokes session by sessionId
    const revokeRes = await request(app)
      .post('/api/auth/admin/sessions/revoke')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ sessionId });
    expect(revokeRes.status).toBe(200);
    expect(revokeRes.body.revokedCount).toBeGreaterThan(0);

    // 3. /me with revoked token returns 401
    const meRes = await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${token}`);
    expect(meRes.status).toBe(401);
  });

  test('Account lock automatically revokes all active sessions for that account', async () => {
    const accountId = 'ACC004';
    // 1. Login to create active session
    const loginRes = await request(app)
      .post('/api/auth/login')
      .send({ accountId, password: DEMO_PASSWORD });
    const token = loginRes.body.token;

    // Verify session is active
    const meBefore = await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${token}`);
    expect(meBefore.status).toBe(200);

    // 2. Trigger account lock by 5 wrong attempts
    for (let i = 0; i < 5; i++) {
      await request(app)
        .post('/api/auth/login')
        .send({ accountId, password: 'WrongPassword' });
    }

    // 3. The previously active session must now be revoked
    const meAfter = await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${token}`);
    expect(meAfter.status).toBe(401);
  });
});

