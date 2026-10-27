const express = require('express');
const crypto = require('crypto');
const { driver } = require('../config/neo4j');
const redis = require('../config/redis');
const { requireSession, requireRole } = require('../middleware/authMiddleware');
const { publishEvent } = require('../services/events');

const router = express.Router();

/**
 * So sánh an toàn thời gian mã OTP để chống Timing Attack bằng crypto.timingSafeEqual
 */
function safeCompareOtp(providedOtp, expectedOtp) {
  if (typeof providedOtp !== 'string' || typeof expectedOtp !== 'string') return false;
  const bufA = Buffer.from(providedOtp.trim());
  const bufB = Buffer.from(expectedOtp.trim());
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Hàm thực thi giao dịch chuyển tiền nguyên tử trên Neo4j (ACID)
 */
async function executeTransfer({ fromAccountId, toAccountId, amount, note, clientIp }) {
  const transferAmount = Number(amount);

  if (!fromAccountId || !toAccountId || isNaN(transferAmount) || transferAmount <= 0) {
    throw { status: 400, message: 'Vui lòng nhập fromAccountId, toAccountId và số tiền amount > 0' };
  }

  if (fromAccountId === toAccountId) {
    throw { status: 400, message: 'Không thể tự chuyển tiền cho chính mình (fromAccountId trùng toAccountId)' };
  }

  // Kiểm tra tài khoản có bị đóng băng trên Redis không (Account Freezing)
  const fromFrozen = await redis.get(`account:frozen:${fromAccountId}`);
  if (fromFrozen) {
    const ttl = await redis.ttl(`account:frozen:${fromAccountId}`);
    await publishEvent('TX_BLOCKED', {
      accountId: fromAccountId,
      ip: clientIp || '127.0.0.1',
      detail: `Chặn giao dịch gửi từ tài khoản đang bị đóng băng (${fromFrozen})`
    });
    throw {
      status: 423,
      message: `Tài khoản ${fromAccountId} đang bị đóng băng (${fromFrozen})`,
      reason: fromFrozen,
      remainingSeconds: ttl > 0 ? ttl : 0,
      frozenAccount: fromAccountId
    };
  }

  const toFrozen = await redis.get(`account:frozen:${toAccountId}`);
  if (toFrozen) {
    const ttl = await redis.ttl(`account:frozen:${toAccountId}`);
    await publishEvent('TX_BLOCKED', {
      accountId: toAccountId,
      ip: clientIp || '127.0.0.1',
      detail: `Chặn giao dịch đến tài khoản nhận đang bị đóng băng (${toFrozen})`
    });
    throw {
      status: 423,
      message: `Tài khoản nhận ${toAccountId} đang bị đóng băng (${toFrozen})`,
      reason: toFrozen,
      remainingSeconds: ttl > 0 ? ttl : 0,
      frozenAccount: toAccountId
    };
  }

  const fraudMode = (await redis.get('config:fraud_mode')) || 'ALERT';
  const session = driver.session();

  try {
    const txId = `TX_${Date.now()}_${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
    const timestamp = Date.now();
    const txNote = note || 'Chuyển khoản ngân hàng';

    // Sử dụng executeWrite (Explicit Transaction) của Neo4j để đảm bảo tính chất Atomic Transaction (ACID)
    const txResult = await session.executeWrite(async (tx) => {
      // Chiếm khóa ghi trước khi kiểm tra số dư (SET thuộc tính phụ _txLock trên node nguồn trước)
      const lockRes = await tx.run(
        `
        MATCH (from:Account {accountId: $fromAccountId})
        SET from._txLock = $timestamp
        RETURN from
        `,
        { fromAccountId, timestamp }
      );

      if (lockRes.records.length === 0) {
        throw { status: 404, message: `Tài khoản nguồn ${fromAccountId} không tồn tại` };
      }

      // Kiểm tra tài khoản đích và số dư sau khi đã nắm khóa ghi
      const checkRes = await tx.run(
        `
        MATCH (from:Account {accountId: $fromAccountId})
        OPTIONAL MATCH (to:Account {accountId: $toAccountId})
        RETURN from, to
        `,
        { fromAccountId, toAccountId }
      );

      const record = checkRes.records[0];
      const fromNode = record.get('from');
      const toNode = record.get('to');

      if (!toNode) {
        throw { status: 404, message: `Tài khoản đích ${toAccountId} không tồn tại` };
      }

      const fromProps = fromNode.properties;
      const toProps = toNode.properties;

      if (fromProps.status === 'CLOSED' || toProps.status === 'CLOSED') {
        throw { status: 400, message: 'Một trong hai tài khoản đã bị đóng (CLOSED)' };
      }

      if (fromProps.balance < transferAmount) {
        throw {
          status: 400,
          message: `Số dư tài khoản ${fromAccountId} không đủ (Hiện có: ${Number(fromProps.balance).toLocaleString('vi-VN')}đ, Cần chuyển: ${transferAmount.toLocaleString('vi-VN')}đ)`
        };
      }

      // Nếu chế độ BLOCK, kiểm tra xem giao dịch from -> to có khép kín chu trình 3 đỉnh không TRƯỚC KHI tạo cạnh và trừ tiền
      if (fraudMode === 'BLOCK') {
        const preCheck = await tx.run(
          `
          MATCH (to:Account {accountId: $toAccountId})-[r2:TRANSFERRED]->(c:Account)-[r3:TRANSFERRED]->(from:Account {accountId: $fromAccountId})
          WHERE c.accountId <> $toAccountId AND c.accountId <> $fromAccountId
          RETURN c.accountId AS intermediateAccount, r2.txId AS tx2, r3.txId AS tx3
          LIMIT 1
          `,
          { fromAccountId, toAccountId }
        );

        if (preCheck.records.length > 0) {
          const intermediate = preCheck.records[0].get('intermediateAccount');
          const blockedCyclePath = `${fromAccountId} → ${toAccountId} → ${intermediate} → ${fromAccountId}`;
          await publishEvent('CYCLE_DETECTED', {
            accountId: fromAccountId,
            ip: clientIp || '127.0.0.1',
            detail: `Phát hiện chu trình rửa tiền (BLOCK mode): ${blockedCyclePath}`
          });
          await publishEvent('TX_BLOCKED', {
            accountId: fromAccountId,
            ip: clientIp || '127.0.0.1',
            detail: `Chặn giao dịch khép vòng gian lận: ${blockedCyclePath}`
          });
          throw {
            status: 409,
            message: 'Giao dịch bị CHẶN do tạo chu trình rửa tiền đáng ngờ!',
            blocked: true,
            cyclePath: blockedCyclePath
          };
        }
      }

      // Trừ tiền tài khoản gửi, cộng tiền tài khoản nhận, xóa khóa _txLock và tạo cạnh TRANSFERRED trong cùng 1 transaction
      const updateRes = await tx.run(
        `
        MATCH (from:Account {accountId: $fromAccountId})
        MATCH (to:Account {accountId: $toAccountId})
        SET from.balance = from.balance - $amount,
            to.balance = to.balance + $amount
        REMOVE from._txLock
        CREATE (from)-[r:TRANSFERRED {
          txId: $txId,
          amount: $amount,
          timestamp: $timestamp,
          note: $note
        }]->(to)
        RETURN from.balance AS newFromBalance, to.balance AS newToBalance, r
        `,
        {
          fromAccountId,
          toAccountId,
          amount: transferAmount,
          txId,
          timestamp,
          note: txNote
        }
      );

      // Tự động kiểm tra ngay xem cạnh vừa tạo có khép kín chu trình 3 đỉnh không
      const cycleRes = await tx.run(
        `
        MATCH (a:Account {accountId: $fromAccountId})-[r1:TRANSFERRED {txId: $txId}]->(b:Account {accountId: $toAccountId})
        MATCH (b)-[r2:TRANSFERRED]->(c:Account)-[r3:TRANSFERRED]->(a)
        WHERE a.accountId <> b.accountId
          AND b.accountId <> c.accountId
          AND c.accountId <> a.accountId
        WITH a, b, c, r1,
             collect(DISTINCT r2) AS rels2,
             collect(DISTINCT r3) AS rels3
        WITH a, b, c, ([r1] + rels2 + rels3) AS allRels
        WITH a, b, c,
             [r IN allRels | r.txId] AS txIds,
             reduce(total = 0, r IN allRels | total + r.amount) AS totalAmount
        RETURN a.accountId AS accA, b.accountId AS accB, c.accountId AS accC,
               txIds, totalAmount
        LIMIT 5
        `,
        { fromAccountId, toAccountId, txId }
      );

      const seenTriplets = new Set();
      const detectedCycles = [];
      for (const c of cycleRes.records) {
        const accA = c.get('accA');
        const accB = c.get('accB');
        const accC = c.get('accC');
        const tripKey = `${accA}:${accB}:${accC}`;
        if (seenTriplets.has(tripKey)) continue;
        seenTriplets.add(tripKey);

        let txIds = c.get('txIds');
        if (!txIds || !Array.isArray(txIds)) {
          txIds = [c.get('tx1'), c.get('tx2'), c.get('tx3')].filter(Boolean);
        }

        detectedCycles.push({
          cyclePath: `${accA} → ${accB} → ${accC} → ${accA}`,
          accounts: [accA, accB, accC],
          txIds,
          totalAmount: c.get('totalAmount')
        });
      }

      const updRecord = updateRes.records[0];
      return {
        newFromBalance: updRecord.get('newFromBalance'),
        newToBalance: updRecord.get('newToBalance'),
        detectedCycles
      };
    });

    const fraudAlert = txResult.detectedCycles.length > 0;

    // Nếu phát hiện chu trình (ở chế độ ALERT), đóng băng cả 3 tài khoản trong chu trình bằng Redis
    if (fraudAlert) {
      const freezeSeconds = Number(process.env.FREEZE_SECONDS) || 900;
      for (const cycle of txResult.detectedCycles) {
        await publishEvent('CYCLE_DETECTED', {
          accountId: fromAccountId,
          ip: clientIp || '127.0.0.1',
          detail: `Cảnh báo chu trình rửa tiền: ${cycle.cyclePath}`
        });
        for (const accId of cycle.accounts) {
          await redis.set(`account:frozen:${accId}`, 'CYCLE', 'EX', freezeSeconds);
          await publishEvent('ACCOUNT_FROZEN', {
            accountId: accId,
            ip: clientIp || '127.0.0.1',
            detail: `Đóng băng do thuộc chu trình: ${cycle.cyclePath}`
          });
        }
      }
    }

    return {
      txId,
      fromAccountId,
      toAccountId,
      amount: transferAmount,
      timestamp,
      note: txNote,
      newFromBalance: txResult.newFromBalance,
      newToBalance: txResult.newToBalance,
      fraudAlert,
      detectedCycles: txResult.detectedCycles,
      transaction: {
        txId,
        fromAccountId,
        toAccountId,
        amount: transferAmount,
        timestamp,
        note: txNote,
        newFromBalance: txResult.newFromBalance,
        newToBalance: txResult.newToBalance
      }
    };
  } finally {
    await session.close();
  }
}

/**
 * POST /api/transactions/initiate
 * Khởi tạo giao dịch chuyển tiền và tạo mã OTP 6 chữ số lưu vào Redis key otp:{txRef} (TTL 60s)
 */
router.post('/initiate', requireRole('CUSTOMER', 'ADMIN'), async (req, res) => {
  const { fromAccountId, toAccountId, amount, note } = req.body;
  const transferAmount = Number(amount);

  if (!fromAccountId || !toAccountId || isNaN(transferAmount) || transferAmount <= 0) {
    return res.status(400).json({
      error: 'Vui lòng nhập fromAccountId, toAccountId và số tiền amount > 0'
    });
  }

  // CUSTOMER chỉ được tạo giao dịch từ tài khoản của chính mình
  if (req.sessionUser?.role !== 'ADMIN' && req.sessionAccountId !== fromAccountId) {
    return res.status(403).json({
      error: `Từ chối giao dịch: Bạn chỉ có thể tạo giao dịch từ tài khoản của chính mình (${req.sessionAccountId})`
    });
  }

  if (fromAccountId === toAccountId) {
    return res.status(400).json({
      error: 'Không thể tự chuyển tiền cho chính mình (fromAccountId trùng toAccountId)'
    });
  }

  // Kiểm tra tài khoản có bị đóng băng trên Redis không
  const fromFrozen = await redis.get(`account:frozen:${fromAccountId}`);
  if (fromFrozen) {
    const ttl = await redis.ttl(`account:frozen:${fromAccountId}`);
    return res.status(423).json({
      error: `Tài khoản ${fromAccountId} đang bị đóng băng (${fromFrozen})`,
      reason: fromFrozen,
      remainingSeconds: ttl > 0 ? ttl : 0,
      frozenAccount: fromAccountId
    });
  }

  const toFrozen = await redis.get(`account:frozen:${toAccountId}`);
  if (toFrozen) {
    const ttl = await redis.ttl(`account:frozen:${toAccountId}`);
    return res.status(423).json({
      error: `Tài khoản nhận ${toAccountId} đang bị đóng băng (${toFrozen})`,
      reason: toFrozen,
      remainingSeconds: ttl > 0 ? ttl : 0,
      frozenAccount: toAccountId
    });
  }

  // Kiểm tra số dư và trạng thái tài khoản trước trong Neo4j
  const checkSession = driver.session();
  try {
    const checkRes = await checkSession.run(
      `MATCH (from:Account {accountId: $fromAccountId})
       OPTIONAL MATCH (to:Account {accountId: $toAccountId})
       RETURN from, to`,
      { fromAccountId, toAccountId }
    );

    if (checkRes.records.length === 0 || !checkRes.records[0].get('from')) {
      return res.status(404).json({ error: `Tài khoản nguồn ${fromAccountId} không tồn tại` });
    }

    const fromNode = checkRes.records[0].get('from');
    const toNode = checkRes.records[0].get('to');

    if (!toNode) {
      return res.status(404).json({ error: `Tài khoản đích ${toAccountId} không tồn tại` });
    }

    if (fromNode.properties.status === 'CLOSED' || toNode.properties.status === 'CLOSED') {
      return res.status(400).json({ error: 'Một trong hai tài khoản đã bị đóng (CLOSED)' });
    }

    if (fromNode.properties.balance < transferAmount) {
      return res.status(400).json({
        error: `Số dư tài khoản ${fromAccountId} không đủ (Hiện có: ${Number(fromNode.properties.balance).toLocaleString('vi-VN')}đ, Cần chuyển: ${transferAmount.toLocaleString('vi-VN')}đ)`
      });
    }
  } finally {
    await checkSession.close();
  }

  // Sinh OTP bằng crypto.randomInt(100000, 1000000) (Việc 4)
  const txRef = 'TXR_' + Date.now() + '_' + crypto.randomBytes(3).toString('hex').toUpperCase();
  const otp = String(crypto.randomInt(100000, 1000000));

  // Lưu trạng thái giao dịch chờ ở Redis hash otp:{txRef}: fromAccountId, toAccountId, amount, note, otp (Việc 1)
  await redis.hset(`otp:${txRef}`, {
    fromAccountId,
    toAccountId,
    amount: String(transferAmount),
    note: note || 'Chuyển khoản ngân hàng',
    otp: String(otp)
  });
  await redis.expire(`otp:${txRef}`, 60);

  const responseBody = {
    message: 'Khởi tạo giao dịch thành công. Vui lòng nhập mã OTP để xác nhận (hiệu lực 60 giây).',
    txRef,
    expiresInSeconds: 60,
    fromAccountId,
    toAccountId,
    amount: transferAmount
  };

  // Mã OTP không được xuất hiện trong log; chỉ trả trong response khi DEMO_MODE=true (Việc 4)
  if (process.env.DEMO_MODE === 'true' || process.env.DEMO_MODE === true) {
    responseBody.otp = otp;
  }

  return res.status(200).json(responseBody);
});

/**
 * POST /api/transactions/confirm
 * Xác nhận giao dịch với { txRef, otp } rồi mới ghi giao dịch vào Neo4j.
 * Chỉ lấy { fromAccountId, toAccountId, amount, note, otp } từ Redis hash otp:{txRef}.
 * Tối đa 3 lần thử (INCR otp:attempts:{txRef}, EXPIRE 60).
 */
router.post('/confirm', requireRole('CUSTOMER', 'ADMIN'), async (req, res) => {
  const { txRef, otp } = req.body;

  if (!txRef || !otp) {
    return res.status(400).json({ error: 'Vui lòng cung cấp mã tham chiếu txRef và mã otp' });
  }

  // 1. /confirm CHỈ lấy các giá trị này từ Redis hash otp:{txRef}, bỏ qua mọi from/to/amount trong body (Việc 1)
  const txData = await redis.hgetall(`otp:${txRef}`);
  if (!txData || !txData.otp || !txData.fromAccountId) {
    return res.status(400).json({
      error: 'Mã OTP đã hết hạn hoặc giao dịch không tồn tại. Vui lòng thực hiện lại giao dịch.'
    });
  }

  // Từ chối 403 nếu accountId của phiên khác fromAccountId đã lưu (Việc 1)
  if (req.sessionAccountId !== txData.fromAccountId) {
    return res.status(403).json({
      error: `Từ chối giao dịch: Tài khoản phiên (${req.sessionAccountId}) không khớp với tài khoản gửi đã lưu (${txData.fromAccountId})`
    });
  }

  // 2. Đếm lần thử OTP đúng 3 lần: INCR otp:attempts:{txRef} TRƯỚC khi so sánh (Việc 2)
  const attempts = await redis.incr(`otp:attempts:${txRef}`);
  if (attempts === 1) {
    await redis.expire(`otp:attempts:${txRef}`, 60);
  }

  // Nếu giá trị > 3 thì xóa hash và bộ đếm rồi trả 400, không so sánh OTP (Việc 2)
  if (attempts > 3) {
    await redis.del(`otp:${txRef}`);
    await redis.del(`otp:attempts:${txRef}`);
    return res.status(400).json({
      error: 'Đã vượt quá số lần nhập OTP cho phép (tối đa 3 lần). Giao dịch đã bị hủy.',
      attempts,
      maxAttempts: 3
    });
  }

  // So sánh OTP bằng crypto.timingSafeEqual
  const isValid = safeCompareOtp(String(otp), String(txData.otp));
  if (!isValid) {
    // Nếu OTP sai mà giá trị == 3 thì xóa hash và bộ đếm và trả 400 "Đã hết lượt thử" (Việc 2)
    if (attempts === 3) {
      await redis.del(`otp:${txRef}`);
      await redis.del(`otp:attempts:${txRef}`);
      return res.status(400).json({
        error: 'Mã OTP không chính xác. Đã hết lượt thử.',
        attempts: 3,
        remainingAttempts: 0
      });
    }

    // Nếu giá trị < 3 trả 401 kèm số lần thử còn lại (Việc 2)
    const remainingAttempts = 3 - attempts;
    return res.status(401).json({
      error: `Mã OTP không chính xác. Còn ${remainingAttempts} lần thử.`,
      attempts,
      remainingAttempts
    });
  }

  // 1. Giành quyền xử lý nguyên tử ở /confirm: sau khi xác thực OTP đúng, gọi DEL otp:{txRef} và CHỈ chạy tiếp khi kết quả trả về là 1; nếu bằng 0 thì trả 409 {error:"Giao dịch đã được xử lý hoặc đã hết hạn"} (Việc 1)
  const delResult = await redis.del(`otp:${txRef}`);
  await redis.del(`otp:attempts:${txRef}`);

  if (delResult !== 1) {
    return res.status(409).json({
      error: 'Giao dịch đã được xử lý hoặc đã hết hạn'
    });
  }

  // Thực hiện ghi giao dịch vào Neo4j bằng executeTransfer (kiểm tra lại số dư và trạng thái tài khoản BÊN TRONG giao dịch ACID của Neo4j)
  try {
    const result = await executeTransfer({
      fromAccountId: txData.fromAccountId,
      toAccountId: txData.toAccountId,
      amount: Number(txData.amount),
      note: txData.note,
      clientIp: req.sessionMeta?.ip || req.ip || '127.0.0.1'
    });

    return res.status(201).json({
      message: result.fraudAlert
        ? `Giao dịch thành công nhưng PHÁT HIỆN CHU TRÌNH ĐÁNG NGỜ (${result.detectedCycles[0].cyclePath})!`
        : 'Giao dịch chuyển tiền đã được xác nhận và hoàn tất thành công',
      txRef,
      transaction: result.transaction,
      fraudAlert: result.fraudAlert,
      detectedCycles: result.detectedCycles
    });
  } catch (err) {
    // Nếu giao dịch ACID ở Neo4j thất bại sau đó, trả lỗi rõ ràng và yêu cầu khách khởi tạo lại (không khôi phục OTP) (Việc 1)
    const errorMsg = err.message
      ? `${err.message}. Vui lòng khởi tạo lại giao dịch.`
      : 'Giao dịch thất bại. Vui lòng khởi tạo lại giao dịch.';
    return res.status(err.status || 400).json({
      error: errorMsg,
      reason: err.reason,
      remainingSeconds: err.remainingSeconds,
      frozenAccount: err.frozenAccount,
      blocked: err.blocked || false,
      cyclePath: err.cyclePath || undefined,
      requireReinitiate: true
    });
  }
});

/**
 * POST /api/transactions
 * Route cũ: Tạo Atomic Transaction trên Neo4j (ACID).
 * Vẫn dùng được cho ADMIN để seed kịch bản hoặc khách hàng khi được phép.
 */
router.post('/', requireSession, async (req, res) => {
  const { fromAccountId, toAccountId, amount, note } = req.body;

  // Điểm 4: fromAccountId phải trùng tài khoản của session đối với CUSTOMER; ADMIN có thể tạo giao dịch để seed kịch bản
  if (req.sessionUser?.role !== 'ADMIN' && req.sessionAccountId !== fromAccountId) {
    return res.status(403).json({
      error: `Từ chối giao dịch: Tài khoản phiên đăng nhập (${req.sessionAccountId}) không khớp tài khoản gửi (${fromAccountId})`
    });
  }

  try {
    const result = await executeTransfer({
      fromAccountId,
      toAccountId,
      amount,
      note,
      clientIp: req.sessionMeta?.ip || req.ip || '127.0.0.1'
    });

    return res.status(201).json({
      message: result.fraudAlert
        ? `Giao dịch thành công nhưng PHÁT HIỆN CHU TRÌNH ĐÁNG NGỜ (${result.detectedCycles[0].cyclePath})!`
        : 'Giao dịch chuyển tiền thành công',
      transaction: result.transaction,
      fraudAlert: result.fraudAlert,
      detectedCycles: result.detectedCycles
    });
  } catch (err) {
    if (err.status) {
      return res.status(err.status).json({
        error: err.message,
        reason: err.reason,
        remainingSeconds: err.remainingSeconds,
        frozenAccount: err.frozenAccount,
        blocked: err.blocked || false,
        cyclePath: err.cyclePath || undefined
      });
    }
    console.error('[POST Transaction] Lỗi:', err.message);
    return res.status(500).json({ error: 'Lỗi máy chủ khi thực hiện giao dịch' });
  }
});

/**
 * GET /api/transactions
 * Lấy danh sách các giao dịch gần nhất trên hệ thống
 */
router.get('/', async (req, res) => {
  const limit = Number(req.query.limit) || 150;
  const session = driver.session();
  try {
    const result = await session.run(
      `
      MATCH (a:Account)-[r:TRANSFERRED]->(b:Account)
      RETURN a.accountId AS fromAccount,
             a.ownerName AS fromName,
             b.accountId AS toAccount,
             b.ownerName AS toName,
             r.txId AS txId,
             r.amount AS amount,
             r.timestamp AS timestamp,
             r.note AS note
      ORDER BY r.timestamp DESC
      LIMIT toInteger($limit)
      `,
      { limit }
    );

    const transactions = result.records.map(rec => ({
      txId: rec.get('txId'),
      fromAccount: rec.get('fromAccount'),
      fromName: rec.get('fromName'),
      toAccount: rec.get('toAccount'),
      toName: rec.get('toName'),
      amount: rec.get('amount'),
      timestamp: rec.get('timestamp'),
      note: rec.get('note')
    }));

    return res.json({ count: transactions.length, transactions });
  } catch (err) {
    console.error('[GET Transactions] Lỗi:', err.message);
    return res.status(500).json({ error: 'Lỗi khi tải danh sách giao dịch' });
  } finally {
    await session.close();
  }
});

module.exports = router;
