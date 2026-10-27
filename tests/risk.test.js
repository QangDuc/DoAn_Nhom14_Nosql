const request = require('supertest');
const app = require('../src/server');
const { resetTestData, cleanTestData, getAdminToken } = require('./testHelper');

describe('Risk Scoring Tests', () => {
  beforeAll(async () => {
    await resetTestData();
  });

  afterAll(async () => {
    await cleanTestData();
  });

  test('GET /api/risk/scores returns 50 accounts with scores in [0, 100] and cycle accounts >= MEDIUM', async () => {
    const adminToken = await getAdminToken(app);
    const res = await request(app)
      .get('/api/risk/scores')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(50);

    for (const item of res.body) {
      expect(item.score).toBeGreaterThanOrEqual(0);
      expect(item.score).toBeLessThanOrEqual(100);
      expect(['LOW', 'MEDIUM', 'HIGH']).toContain(item.level);

      // Account participating in cycle must have level >= MEDIUM (score >= 40)
      if (item.factors.inCycle) {
        expect(['MEDIUM', 'HIGH']).toContain(item.level);
        expect(item.score).toBeGreaterThanOrEqual(40);
      }
    }

    // In seeded database, ACC001..ACC009 are in cycles
    const cycleAccs = res.body.filter((item) => ['ACC001', 'ACC002', 'ACC003'].includes(item.accountId));
    expect(cycleAccs.length).toBe(3);
    for (const acc of cycleAccs) {
      expect(acc.factors.inCycle).toBe(true);
      expect(acc.score).toBeGreaterThanOrEqual(40);
    }
  });
});

