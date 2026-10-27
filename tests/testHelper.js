const { seedAllData } = require('../src/seed');
const redis = require('../src/config/redis');
const { driver } = require('../src/config/neo4j');
const request = require('supertest');

const DEMO_PASSWORD = 'MatKhau@123';
const ADMIN_PASSWORD = process.env.ADMIN_DEMO_PASSWORD || 'Admin@123';
const STAFF_PASSWORD = process.env.STAFF_DEMO_PASSWORD || 'TestStaff@123';

async function resetTestData() {
  await seedAllData();
}

async function cleanTestData() {
  const session = driver.session();
  try {
    await session.run(`MATCH (n) DETACH DELETE n`);
  } catch (_) {} finally {
    await session.close();
  }
  try {
    await redis.flushdb();
  } catch (_) {}
}

async function getAdminToken(app) {
  let res = await request(app)
    .post('/api/auth/login')
    .send({ accountId: 'ACC001', password: ADMIN_PASSWORD });
  if (res.body.token) return res.body.token;
  res = await request(app)
    .post('/api/staff/login')
    .send({ staffId: 'STAFF001', password: STAFF_PASSWORD });
  return res.body.token;
}

async function getAnalystToken(app) {
  const res = await request(app)
    .post('/api/staff/login')
    .send({ staffId: 'STAFF002', password: STAFF_PASSWORD });
  return res.body.token;
}

module.exports = {
  resetTestData,
  cleanTestData,
  DEMO_PASSWORD,
  STAFF_PASSWORD,
  getAdminToken,
  getAnalystToken,
  redis,
  driver
};
