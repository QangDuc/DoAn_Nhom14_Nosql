const express = require('express');
const bcrypt = require('bcryptjs');
const { driver } = require('../config/neo4j');
const { requireRole, revokeAccountSessions } = require('../middleware/authMiddleware');
const { logAudit } = require('../services/audit');

const router = express.Router();

/**
 * GET /api/accounts
 * Xem danh sách toàn bộ tài khoản (ẩn passwordHash)
 */
router.get('/', requireRole('ADMIN'), async (req, res) => {
  const session = driver.session();
  try {
    const result = await session.run(`
      MATCH (a:Account)
      RETURN a
      ORDER BY a.accountId ASC
    `);

    const accounts = result.records.map(r => {
      const props = r.get('a').properties;
      return {
        accountId: props.accountId,
        ownerName: props.ownerName,
        balance: props.balance,
        status: props.status,
        createdAt: props.createdAt
      };
    });

    return res.json({ count: accounts.length, accounts });
  } catch (err) {
    console.error('[GET Accounts] Lỗi:', err.message);
    return res.status(500).json({ error: 'Lỗi khi tải danh sách tài khoản' });
  } finally {
    await session.close();
  }
});

/**
 * GET /api/accounts/:accountId
 * Xem chi tiết một tài khoản
 */
router.get('/:accountId', requireRole('ADMIN', 'CUSTOMER'), async (req, res) => {
  const { accountId } = req.params;
  const session = driver.session();
  try {
    const result = await session.run(
      `MATCH (a:Account {accountId: $accountId}) RETURN a`,
      { accountId }
    );

    if (result.records.length === 0) {
      return res.status(404).json({ error: `Không tìm thấy tài khoản ${accountId}` });
    }

    const props = result.records[0].get('a').properties;
    return res.json({
      accountId: props.accountId,
      ownerName: props.ownerName,
      balance: props.balance,
      status: props.status,
      createdAt: props.createdAt
    });
  } catch (err) {
    console.error('[GET Account Detail] Lỗi:', err.message);
    return res.status(500).json({ error: 'Lỗi khi xem chi tiết tài khoản' });
  } finally {
    await session.close();
  }
});

/**
 * POST /api/accounts
 * Tạo tài khoản mới (Chỉ ADMIN)
 */
router.post('/', requireRole('ADMIN'), async (req, res) => {
  const { accountId, ownerName, password, balance } = req.body;
  if (!accountId || !ownerName || !password) {
    return res.status(400).json({ error: 'Vui lòng cung cấp accountId, ownerName và password' });
  }

  const initialBalance = balance !== undefined ? Number(balance) : 10000000;
  if (isNaN(initialBalance) || initialBalance < 0) {
    return res.status(400).json({ error: 'Số dư khởi tạo không hợp lệ' });
  }

  const session = driver.session();
  try {
    const passwordHash = await bcrypt.hash(password, 10);
    const createdAt = Date.now();

    const result = await session.run(
      `
      CREATE (a:Account {
        accountId: $accountId,
        ownerName: $ownerName,
        passwordHash: $passwordHash,
        balance: $balance,
        status: 'ACTIVE',
        createdAt: $createdAt
      })
      RETURN a
      `,
      { accountId, ownerName, passwordHash, balance: initialBalance, createdAt }
    );

    const props = result.records[0].get('a').properties;

    await logAudit({
      actor: req.sessionUser?.subjectId || 'UNKNOWN',
      role: req.sessionUser?.role || 'ADMIN',
      action: 'CREATE_ACCOUNT',
      target: accountId,
      ip: req.sessionUser?.ip || req.ip || '127.0.0.1'
    });

    return res.status(201).json({
      message: 'Tạo tài khoản thành công',
      account: {
        accountId: props.accountId,
        ownerName: props.ownerName,
        balance: props.balance,
        status: props.status,
        createdAt: props.createdAt
      }
    });
  } catch (err) {
    if (err.code === 'Neo.ClientError.Schema.ConstraintValidationFailed') {
      return res.status(409).json({ error: `Mã tài khoản ${accountId} đã tồn tại` });
    }
    console.error('[POST Account] Lỗi:', err.message);
    return res.status(500).json({ error: 'Lỗi khi tạo tài khoản' });
  } finally {
    await session.close();
  }
});

/**
 * PUT /api/accounts/:accountId
 * Sửa thông tin tài khoản (ownerName, balance, status, hoặc đổi password) (Chỉ ADMIN)
 */
router.put('/:accountId', requireRole('ADMIN'), async (req, res) => {
  const { accountId } = req.params;
  const { ownerName, balance, status, password } = req.body;

  const session = driver.session();
  try {
    const check = await session.run(
      `MATCH (a:Account {accountId: $accountId}) RETURN a`,
      { accountId }
    );

    if (check.records.length === 0) {
      return res.status(404).json({ error: `Không tìm thấy tài khoản ${accountId}` });
    }

    const current = check.records[0].get('a').properties;
    const newOwnerName = ownerName !== undefined ? ownerName : current.ownerName;
    const newBalance = balance !== undefined ? Number(balance) : current.balance;
    const newStatus = status !== undefined ? status : current.status;
    const newPasswordHash = password ? await bcrypt.hash(password, 10) : current.passwordHash;

    const result = await session.run(
      `
      MATCH (a:Account {accountId: $accountId})
      SET a.ownerName = $ownerName,
          a.balance = $balance,
          a.status = $status,
          a.passwordHash = $passwordHash
      RETURN a
      `,
      {
        accountId,
        ownerName: newOwnerName,
        balance: newBalance,
        status: newStatus,
        passwordHash: newPasswordHash
      }
    );

    const updated = result.records[0].get('a').properties;

    // Nếu tài khoản bị đóng (CLOSED), tự động thu hồi/xóa tất cả phiên hoạt động
    if (newStatus === 'CLOSED') {
      await revokeAccountSessions(accountId);
    }

    await logAudit({
      actor: req.sessionUser?.subjectId || 'UNKNOWN',
      role: req.sessionUser?.role || 'ADMIN',
      action: 'UPDATE_ACCOUNT',
      target: accountId,
      ip: req.sessionUser?.ip || req.ip || '127.0.0.1'
    });

    return res.json({
      message: 'Cập nhật tài khoản thành công',
      account: {
        accountId: updated.accountId,
        ownerName: updated.ownerName,
        balance: updated.balance,
        status: updated.status,
        createdAt: updated.createdAt
      }
    });
  } catch (err) {
    console.error('[PUT Account] Lỗi:', err.message);
    return res.status(500).json({ error: 'Lỗi khi cập nhật tài khoản' });
  } finally {
    await session.close();
  }
});

/**
 * DELETE /api/accounts/:accountId
 * Đóng hoặc xóa tài khoản (Chỉ ADMIN)
 */
router.delete('/:accountId', requireRole('ADMIN'), async (req, res) => {
  const { accountId } = req.params;
  const hardDelete = req.query.hard === 'true';

  const session = driver.session();
  try {
    if (hardDelete) {
      const result = await session.run(
        `
        MATCH (a:Account {accountId: $accountId})
        WITH a, count(a) AS cnt
        DETACH DELETE a
        RETURN cnt
        `,
        { accountId }
      );
      if (result.records.length === 0) {
        return res.status(404).json({ error: `Không tìm thấy tài khoản ${accountId}` });
      }
      await revokeAccountSessions(accountId);
      await logAudit({
        actor: req.sessionUser?.subjectId || 'UNKNOWN',
        role: req.sessionUser?.role || 'ADMIN',
        action: 'DELETE_ACCOUNT',
        target: accountId,
        ip: req.sessionUser?.ip || req.ip || '127.0.0.1'
      });
      return res.json({ message: `Đã xóa vĩnh viễn tài khoản ${accountId}` });
    } else {
      const result = await session.run(
        `
        MATCH (a:Account {accountId: $accountId})
        SET a.status = 'CLOSED'
        RETURN a
        `,
        { accountId }
      );
      if (result.records.length === 0) {
        return res.status(404).json({ error: `Không tìm thấy tài khoản ${accountId}` });
      }
      await revokeAccountSessions(accountId);
      await logAudit({
        actor: req.sessionUser?.subjectId || 'UNKNOWN',
        role: req.sessionUser?.role || 'ADMIN',
        action: 'CLOSE_ACCOUNT',
        target: accountId,
        ip: req.sessionUser?.ip || req.ip || '127.0.0.1'
      });
      return res.json({
        message: `Đã đóng tài khoản ${accountId}`,
        accountId,
        status: 'CLOSED'
      });
    }
  } catch (err) {
    console.error('[DELETE Account] Lỗi:', err.message);
    return res.status(500).json({ error: 'Lỗi khi xóa/đóng tài khoản' });
  } finally {
    await session.close();
  }
});

/**
 * GET /api/accounts/:accountId/transactions
 * Xem lịch sử giao dịch (gửi và nhận) của một tài khoản
 */
router.get('/:accountId/transactions', requireRole('ADMIN', 'CUSTOMER'), async (req, res) => {
  const { accountId } = req.params;
  const session = driver.session();
  try {
    const result = await session.run(
      `
      MATCH (from:Account)-[r:TRANSFERRED]->(to:Account)
      WHERE from.accountId = $accountId OR to.accountId = $accountId
      RETURN from.accountId AS fromAccount,
             from.ownerName AS fromName,
             to.accountId AS toAccount,
             to.ownerName AS toName,
             r.txId AS txId,
             r.amount AS amount,
             r.timestamp AS timestamp,
             r.note AS note
      ORDER BY r.timestamp DESC
      `,
      { accountId }
    );

    const transactions = result.records.map(rec => ({
      txId: rec.get('txId'),
      fromAccount: rec.get('fromAccount'),
      fromName: rec.get('fromName'),
      toAccount: rec.get('toAccount'),
      toName: rec.get('toName'),
      amount: rec.get('amount'),
      timestamp: rec.get('timestamp'),
      direction: rec.get('fromAccount') === accountId ? 'OUTGOING' : 'INCOMING',
      note: rec.get('note')
    }));

    return res.json({
      accountId,
      count: transactions.length,
      transactions
    });
  } catch (err) {
    console.error('[GET Account Transactions] Lỗi:', err.message);
    return res.status(500).json({ error: 'Lỗi khi lấy lịch sử giao dịch của tài khoản' });
  } finally {
    await session.close();
  }
});

module.exports = router;
