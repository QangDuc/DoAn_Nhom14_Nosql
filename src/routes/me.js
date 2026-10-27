const express = require('express');
const { driver } = require('../config/neo4j');
const { requireRole } = require('../middleware/authMiddleware');

const router = express.Router();

/**
 * GET /api/me/account
 * Khách hàng xem thông tin tài khoản và số dư của chính mình (TUYỆT ĐỐI không trả passwordHash)
 */
router.get('/account', requireRole('CUSTOMER', 'ADMIN'), async (req, res) => {
  const accountId = req.sessionUser.accountId || req.sessionUser.subjectId;
  const session = driver.session();
  try {
    const result = await session.run(
      `MATCH (a:Account {accountId: $accountId}) RETURN a`,
      { accountId }
    );

    if (result.records.length === 0) {
      return res.status(404).json({ error: `Không tìm thấy thông tin tài khoản ${accountId}` });
    }

    const props = result.records[0].get('a').properties;
    return res.json({
      account: {
        accountId: props.accountId,
        ownerName: props.ownerName,
        balance: props.balance,
        status: props.status,
        createdAt: props.createdAt
      }
    });
  } catch (err) {
    console.error('[GET /api/me/account] Lỗi:', err.message);
    return res.status(500).json({ error: 'Lỗi khi tải thông tin tài khoản' });
  } finally {
    await session.close();
  }
});

/**
 * GET /api/me/transactions
 * Khách hàng xem lịch sử giao dịch của chính mình (cả gửi và nhận)
 */
router.get('/transactions', requireRole('CUSTOMER', 'ADMIN'), async (req, res) => {
  const accountId = req.sessionUser.accountId || req.sessionUser.subjectId;
  const session = driver.session();
  try {
    const result = await session.run(
      `
      MATCH (a:Account)-[r:TRANSFERRED]->(b:Account)
      WHERE a.accountId = $accountId OR b.accountId = $accountId
      RETURN a.accountId AS fromAccount,
             a.ownerName AS fromName,
             b.accountId AS toAccount,
             b.ownerName AS toName,
             r.txId AS txId,
             r.amount AS amount,
             r.timestamp AS timestamp,
             r.note AS note,
             (a.accountId = $accountId) AS isOutgoing
      ORDER BY r.timestamp DESC
      LIMIT 100
      `,
      { accountId }
    );

    const transactions = result.records.map((rec) => ({
      txId: rec.get('txId'),
      fromAccount: rec.get('fromAccount'),
      fromName: rec.get('fromName'),
      toAccount: rec.get('toAccount'),
      toName: rec.get('toName'),
      amount: rec.get('amount'),
      timestamp: rec.get('timestamp'),
      note: rec.get('note'),
      isOutgoing: rec.get('isOutgoing')
    }));

    return res.json({
      accountId,
      count: transactions.length,
      transactions
    });
  } catch (err) {
    console.error('[GET /api/me/transactions] Lỗi:', err.message);
    return res.status(500).json({ error: 'Lỗi khi tải lịch sử giao dịch' });
  } finally {
    await session.close();
  }
});

module.exports = router;

