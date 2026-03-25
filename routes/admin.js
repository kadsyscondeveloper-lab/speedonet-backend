// routes/admin.js
const router = require('express').Router();
const { db, sql } = require('../config/db');
const { authenticateAdmin } = require('../middleware/adminAuth');
const R = require('../utils/response');
const logger = require('../utils/logger');
const payServicesCtrl = require('../controllers/payServicesController');
const notifyUser = require('../utils/notifyUser');
const { broadcast } = require('../services/fcmService');

router.use(authenticateAdmin);
const { adminLimiter } = require('../middleware/errorHandler');
router.use(adminLimiter);

// =============================================================================
// GET /admin/stats
// =============================================================================
router.get('/stats', async (req, res, next) => {
  try {
    const [userCount, kycPending, activeSubs, revenueToday] = await Promise.all([
      db.selectFrom('dbo.users').select(db.fn.count('id').as('n')).executeTakeFirstOrThrow(),
      db.selectFrom('dbo.kyc_submissions').select(db.fn.count('id').as('n')).where('status', '=', 'pending').executeTakeFirstOrThrow(),
      db.selectFrom('dbo.user_subscriptions').select(db.fn.count('id').as('n')).where('status', '=', 'active').where('expires_at', '>=', sql`CAST(SYSDATETIME() AS DATE)`).executeTakeFirstOrThrow(),
      sql`SELECT ISNULL(SUM(CAST(total_amount AS DECIMAL(12,2))),0) AS n FROM dbo.payment_orders WHERE payment_status='success' AND CAST(paid_at AS DATE)=CAST(SYSDATETIME() AS DATE)`.execute(db).then(r => r.rows[0]),
    ]);

    return R.ok(res, {
      total_users:   Number(userCount.n),
      pending_kyc:   Number(kycPending.n),
      active_subs:   Number(activeSubs.n),
      revenue_today: Number(revenueToday.n || 0).toFixed(2),
    });
  } catch (err) { next(err); }
});

// =============================================================================
// GET /admin/users  — paginated user list with search
// SQL Server does not support LIMIT — use OFFSET/FETCH via raw sql``
// =============================================================================
router.get('/users', async (req, res, next) => {
  try {
    const page   = Math.max(1, parseInt(req.query.page  || '1'));
    const limit  = Math.max(1, parseInt(req.query.limit || '15'));
    const search = req.query.search?.trim() || '';
    const offset = (page - 1) * limit;

    const [users, countRow] = await Promise.all([
      sql`
        SELECT
          u.id, u.name, u.phone, u.email,
          u.wallet_balance, u.is_active, u.created_at,
          k.status AS kyc_status
        FROM dbo.users u
        LEFT JOIN dbo.kyc_submissions k
          ON k.id = (SELECT TOP 1 id FROM dbo.kyc_submissions WHERE user_id = u.id ORDER BY submitted_at DESC)
        ${search
          ? sql`WHERE u.name LIKE ${'%'+search+'%'} OR u.phone LIKE ${'%'+search+'%'}`
          : sql``}
        ORDER BY u.created_at DESC
        OFFSET ${offset} ROWS FETCH NEXT ${limit} ROWS ONLY
      `.execute(db).then(r => r.rows),

      search
        ? sql`SELECT COUNT(id) AS total FROM dbo.users WHERE name LIKE ${'%'+search+'%'} OR phone LIKE ${'%'+search+'%'}`.execute(db).then(r => r.rows[0])
        : db.selectFrom('dbo.users').select(db.fn.count('id').as('total')).executeTakeFirstOrThrow(),
    ]);

    const total = Number(countRow.total);
    return R.ok(res, { users }, 'OK', 200, { page, limit, total, total_pages: Math.ceil(total / limit) });
  } catch (err) { next(err); }
});

// =============================================================================
// GET /admin/users/:id
// =============================================================================
router.get('/users/:id', async (req, res, next) => {
  try {
    const userId = parseInt(req.params.id);
    const user = await sql`
      SELECT
        u.id, u.name, u.phone, u.email,
        u.wallet_balance, u.is_active, u.created_at,
        a.house_no, a.address, a.city, a.state, a.pin_code,
        k.status AS kyc_status, k.submitted_at AS kyc_submitted_at,
        rc.code AS referral_code
      FROM dbo.users u
      LEFT JOIN dbo.user_addresses a
        ON a.user_id = u.id AND a.is_primary = 1
      LEFT JOIN dbo.kyc_submissions k
        ON k.id = (SELECT TOP 1 id FROM dbo.kyc_submissions WHERE user_id = u.id ORDER BY submitted_at DESC)
      LEFT JOIN dbo.referral_codes rc ON rc.user_id = u.id
      WHERE u.id = ${BigInt(userId)}
    `.execute(db).then(r => r.rows[0]);

    if (!user) return R.notFound(res, 'User not found');
    return R.ok(res, { user });
  } catch (err) { next(err); }
});

// =============================================================================
// PATCH /admin/users/:id/status
// =============================================================================
router.patch('/users/:id/status', async (req, res, next) => {
  try {
    const userId = parseInt(req.params.id);
    const { is_active } = req.body;
    if (typeof is_active !== 'boolean') return R.badRequest(res, 'is_active (boolean) is required');

    await db.updateTable('dbo.users')
      .set({ is_active, updated_at: sql`SYSUTCDATETIME()` })
      .where('id', '=', BigInt(userId))
      .execute();

    logger.info(`[Admin] User ${userId} ${is_active ? 'activated' : 'deactivated'} by admin ${req.admin.id}`);
    return R.ok(res, null, `User ${is_active ? 'activated' : 'deactivated'} successfully`);
  } catch (err) { next(err); }
});

// =============================================================================
// GET /admin/kyc  — paginated KYC list
// =============================================================================
router.get('/kyc', async (req, res, next) => {
  try {
    const page   = Math.max(1, parseInt(req.query.page  || '1'));
    const limit  = Math.max(1, parseInt(req.query.limit || '12'));
    const status = req.query.status || '';
    const offset = (page - 1) * limit;

    const [submissions, countRow] = await Promise.all([
      sql`
        SELECT
          k.id, k.user_id, k.status,
          k.id_proof_type, k.address_proof_type,
          k.submitted_at, k.reviewed_at, k.rejection_reason,
          u.name AS user_name, u.phone AS user_phone
        FROM dbo.kyc_submissions k
        INNER JOIN dbo.users u ON u.id = k.user_id
        ${status ? sql`WHERE k.status = ${status}` : sql``}
        ORDER BY k.submitted_at DESC
        OFFSET ${offset} ROWS FETCH NEXT ${limit} ROWS ONLY
      `.execute(db).then(r => r.rows),

      status
        ? sql`SELECT COUNT(id) AS total FROM dbo.kyc_submissions WHERE status = ${status}`.execute(db).then(r => r.rows[0])
        : db.selectFrom('dbo.kyc_submissions').select(db.fn.count('id').as('total')).executeTakeFirstOrThrow(),
    ]);

    const total = Number(countRow.total);
    return R.ok(res, { submissions }, 'OK', 200, { page, limit, total, total_pages: Math.ceil(total / limit) });
  } catch (err) { next(err); }
});

// =============================================================================
// GET /admin/kyc/:kycId
// =============================================================================
router.get('/kyc/:kycId', async (req, res, next) => {
  try {
    const kycId = parseInt(req.params.kycId);
    const submission = await sql`
      SELECT
        k.id, k.user_id, k.status,
        k.id_proof_type, k.id_proof_data, k.id_proof_mime,
        k.address_proof_type, k.address_proof_data, k.address_proof_mime,
        k.rejection_reason, k.submitted_at, k.reviewed_at,
        u.name AS user_name, u.phone AS user_phone
      FROM dbo.kyc_submissions k
      INNER JOIN dbo.users u ON u.id = k.user_id
      WHERE k.id = ${BigInt(kycId)}
    `.execute(db).then(r => r.rows[0]);

    if (!submission) return R.notFound(res, 'KYC submission not found');

    // SQL Server returns binary columns as Buffer objects.
    // Convert to base64 strings so the browser can render data: URIs.
    const toB64 = (val) => {
      if (!val) return null;
      if (Buffer.isBuffer(val)) return val.toString('base64');
      if (val?.data) return Buffer.from(val.data).toString('base64'); // tedious varbinary
      if (typeof val === 'string') return val; // already base64
      return null;
    };

    submission.id_proof_data      = toB64(submission.id_proof_data);
    submission.address_proof_data = toB64(submission.address_proof_data);

    return R.ok(res, { submission });
  } catch (err) { next(err); }
});

// =============================================================================
// PATCH /admin/kyc/:userId/:kycId
// =============================================================================
router.patch('/kyc/:userId/:kycId', async (req, res, next) => {
  try {
    const kycId  = parseInt(req.params.kycId);
    const userId = parseInt(req.params.userId);
    const { status, rejection_reason } = req.body;

    const validStatuses = ['approved', 'rejected', 'under_review', 'pending'];
    if (!validStatuses.includes(status)) return R.badRequest(res, `Status must be one of: ${validStatuses.join(', ')}`);
    if (status === 'rejected' && !rejection_reason) return R.badRequest(res, 'rejection_reason is required when rejecting.');

    await db.updateTable('dbo.kyc_submissions')
      .set({ status, rejection_reason: rejection_reason || null, reviewed_at: new Date(), updated_at: sql`SYSUTCDATETIME()` })
      .where('id', '=', BigInt(kycId))
      .where('user_id', '=', BigInt(userId))
      .execute();

    // PATCH 1 — replaced raw db.insertInto('dbo.notifications') with notifyUser
    const notifMap = {
      approved:     { title: 'KYC Approved ✅', body: 'Your KYC verification is complete. You now have full access to all features.' },
      rejected:     { title: 'KYC Rejected ❌', body: rejection_reason ? `Your KYC was rejected: ${rejection_reason}. Please re-submit your documents.` : 'Your KYC was rejected. Please re-submit your documents.' },
      under_review: { title: 'KYC Under Review 🔍', body: "Your documents are being reviewed by our team. We'll notify you once complete." },
    };

    const notif = notifMap[status];
    if (notif) {
      await notifyUser(db, userId, {
        type:  'kyc',
        title: notif.title,
        body:  notif.body,
        data:  { kyc_status: status },
      });
    }

    logger.info(`[Admin] KYC ${kycId} → ${status} by admin ${req.admin.id}`);
    return R.ok(res, null, `KYC status updated to '${status}'. User notified.`);
  } catch (err) { next(err); }
});

// =============================================================================
// GET /admin/payments
// =============================================================================
router.get('/payments', async (req, res, next) => {
  try {
    const page   = Math.max(1, parseInt(req.query.page  || '1'));
    const limit  = Math.max(1, parseInt(req.query.limit || '15'));
    const status = req.query.status || '';
    const offset = (page - 1) * limit;

    const [orders, countRow] = await Promise.all([
      sql`
        SELECT
          po.id, po.order_ref, po.type, po.total_amount,
          po.payment_method, po.payment_status, po.gateway_name, po.created_at,
          u.name AS user_name, u.phone AS user_phone
        FROM dbo.payment_orders po
        INNER JOIN dbo.users u ON u.id = po.user_id
        ${status ? sql`WHERE po.payment_status = ${status}` : sql``}
        ORDER BY po.created_at DESC
        OFFSET ${offset} ROWS FETCH NEXT ${limit} ROWS ONLY
      `.execute(db).then(r => r.rows),

      status
        ? sql`SELECT COUNT(id) AS total FROM dbo.payment_orders WHERE payment_status = ${status}`.execute(db).then(r => r.rows[0])
        : db.selectFrom('dbo.payment_orders').select(db.fn.count('id').as('total')).executeTakeFirstOrThrow(),
    ]);

    const total = Number(countRow.total);
    return R.ok(res, { orders }, 'OK', 200, { page, limit, total, total_pages: Math.ceil(total / limit) });
  } catch (err) { next(err); }
});

// =============================================================================
// GET /admin/subscriptions
// =============================================================================
router.get('/subscriptions', async (req, res, next) => {
  try {
    const limit = Math.max(1, parseInt(req.query.limit || '20'));
    const subscriptions = await sql`
      SELECT TOP (${limit})
        s.id, s.status, s.start_date, s.expires_at,
        u.name AS user_name, u.phone AS user_phone,
        p.name AS plan_name, p.speed_mbps
      FROM dbo.user_subscriptions s
      INNER JOIN dbo.users u ON u.id = s.user_id
      INNER JOIN dbo.broadband_plans p ON p.id = s.plan_id
      ORDER BY s.created_at DESC
    `.execute(db).then(r => r.rows);

    return R.ok(res, { subscriptions });
  } catch (err) { next(err); }
});

// =============================================================================
// GET /admin/tickets
// =============================================================================
router.get('/tickets', async (req, res, next) => {
  try {
    const page   = Math.max(1, parseInt(req.query.page  || '1'));
    const limit  = Math.max(1, parseInt(req.query.limit || '15'));
    const status = req.query.status || '';
    const offset = (page - 1) * limit;

    const [tickets, countRow] = await Promise.all([
      sql`
        SELECT
          t.id, t.ticket_number, t.category, t.subject,
          t.status, t.priority, t.created_at, t.updated_at,
          u.name AS user_name, u.phone AS user_phone
        FROM dbo.help_tickets t
        INNER JOIN dbo.users u ON u.id = t.user_id
        ${status ? sql`WHERE t.status = ${status}` : sql``}
        ORDER BY t.created_at DESC
        OFFSET ${offset} ROWS FETCH NEXT ${limit} ROWS ONLY
      `.execute(db).then(r => r.rows),

      status
        ? sql`SELECT COUNT(id) AS total FROM dbo.help_tickets WHERE status = ${status}`.execute(db).then(r => r.rows[0])
        : db.selectFrom('dbo.help_tickets').select(db.fn.count('id').as('total')).executeTakeFirstOrThrow(),
    ]);

    const total = Number(countRow.total);
    return R.ok(res, { tickets }, 'OK', 200, { page, limit, total, total_pages: Math.ceil(total / limit) });
  } catch (err) { next(err); }
});

// =============================================================================
// GET /admin/tickets/:id
// =============================================================================
router.get('/tickets/:id', async (req, res, next) => {
  try {
    const ticketId = parseInt(req.params.id);
    const ticket = await sql`
      SELECT
        t.id, t.ticket_number, t.category, t.subject, t.description,
        t.status, t.priority, t.resolved_at, t.created_at, t.updated_at,
        u.name AS user_name, u.phone AS user_phone
      FROM dbo.help_tickets t
      INNER JOIN dbo.users u ON u.id = t.user_id
      WHERE t.id = ${BigInt(ticketId)}
    `.execute(db).then(r => r.rows[0]);

    if (!ticket) return R.notFound(res, 'Ticket not found');

    const replies = await db.selectFrom('dbo.ticket_replies')
      .select(['id', 'sender_id', 'sender_type', 'message', 'created_at'])
      .where('ticket_id', '=', BigInt(ticketId))
      .orderBy('created_at', 'asc')
      .execute();

    return R.ok(res, { ticket: { ...ticket, replies } });
  } catch (err) { next(err); }
});

// =============================================================================
// POST /admin/tickets/:id/reply
// =============================================================================
router.post('/tickets/:id/reply', async (req, res, next) => {
  try {
    const ticketId = parseInt(req.params.id);
    const { message } = req.body;
    if (!message?.trim()) return R.badRequest(res, 'Message is required');

    const ticket = await db.selectFrom('dbo.help_tickets').select(['id', 'status', 'user_id'])
      .where('id', '=', BigInt(ticketId)).executeTakeFirst();
    if (!ticket) return R.notFound(res, 'Ticket not found');
    if (ticket.status === 'Closed') return R.badRequest(res, 'Ticket is closed');

    await db.insertInto('dbo.ticket_replies').values({
      ticket_id:   BigInt(ticketId),
      sender_id:   BigInt(req.admin.id),
      sender_type: 'agent',
      message,
    }).execute();

    await db.updateTable('dbo.help_tickets')
      .set({ updated_at: sql`SYSUTCDATETIME()` })
      .where('id', '=', BigInt(ticketId)).execute();

    // PATCH 2 — replaced raw db.insertInto('dbo.notifications') with notifyUser
    await notifyUser(db, Number(ticket.user_id), {
      type:  'support_ticket',
      title: 'Support Reply Received 💬',
      body:  'An agent has replied to your ticket. Check the app for details.',
      data:  { ticket_id: String(ticketId) },
    });

    logger.info(`[Admin] Ticket ${ticketId} reply by admin ${req.admin.id}`);
    return R.ok(res, null, 'Reply sent');
  } catch (err) { next(err); }
});

// =============================================================================
// PATCH /admin/tickets/:id/status
// =============================================================================
router.patch('/tickets/:id/status', async (req, res, next) => {
  try {
    const ticketId = parseInt(req.params.id);
    const { status } = req.body;
    const valid = ['Open', 'In Progress', 'Awaiting User', 'Resolved', 'Closed'];
    if (!valid.includes(status)) return R.badRequest(res, `Status must be one of: ${valid.join(', ')}`);
    const updates = { status, updated_at: sql`SYSUTCDATETIME()` };
    if (status === 'Resolved' || status === 'Closed') updates.resolved_at = new Date();
    await db.updateTable('dbo.help_tickets').set(updates).where('id', '=', BigInt(ticketId)).execute();
    return R.ok(res, null, `Ticket marked ${status}`);
  } catch (err) { next(err); }
});

// =============================================================================
// GET /admin/notifications
// =============================================================================
router.get('/notifications', async (req, res, next) => {
  try {
    const limit = Math.max(1, parseInt(req.query.limit || '20'));
    const notifications = await sql`
      SELECT TOP (${limit})
        n.id, n.title, n.body, n.type, n.created_at,
        u.name AS user_name, u.phone AS user_phone
      FROM dbo.notifications n
      INNER JOIN dbo.users u ON u.id = n.user_id
      ORDER BY n.created_at DESC
    `.execute(db).then(r => r.rows);

    return R.ok(res, { notifications });
  } catch (err) { next(err); }
});

// =============================================================================
// POST /admin/notifications/send
// =============================================================================
router.post('/notifications/send', async (req, res, next) => {
  try {
    const { phone, broadcast: isBroadcast, type = 'general', title, body } = req.body;
    if (!title?.trim() || !body?.trim()) return R.badRequest(res, 'Title and body are required');

    if (isBroadcast) {
      const users  = await db.selectFrom('dbo.users').select('id').where('is_active', '=', true).execute();
      const values = users.map(u => ({ user_id: u.id, type, title, body }));
      for (let i = 0; i < values.length; i += 100) {
        await db.insertInto('dbo.notifications').values(values.slice(i, i + 100)).execute();
      }

      // PATCH 3 — fire FCM broadcast after the DB insert loop
      await broadcast({ title, body, data: { type } });

      logger.info(`[Admin] Broadcast sent to ${users.length} users by admin ${req.admin.id}`);
      return R.ok(res, { sent_to: users.length }, `Broadcast sent to ${users.length} users`);
    }

    if (!phone) return R.badRequest(res, 'Phone number is required for targeted notification');
    const user = await db.selectFrom('dbo.users').select(['id', 'name']).where('phone', '=', phone).executeTakeFirst();
    if (!user) return R.notFound(res, 'No user found with that phone number');

    await db.insertInto('dbo.notifications').values({ user_id: user.id, type, title, body }).execute();
    logger.info(`[Admin] Notification sent to user ${user.id} by admin ${req.admin.id}`);
    return R.ok(res, null, `Notification sent to ${user.name}`);
  } catch (err) { next(err); }
});

// =============================================================================
// GET /admin/carousel
// =============================================================================
router.get('/carousel', async (req, res, next) => {
  try {
    const banners = await db
      .selectFrom('dbo.carousel_banners')
      .select(['id', 'title', 'subtitle', 'image_mime', 'description', 'order', 'is_active', 'created_at'])
      .orderBy('order', 'asc')
      .execute();
    return R.ok(res, { banners });
  } catch (err) { next(err); }
});

// =============================================================================
// DELETE /admin/carousel/:id
// =============================================================================
router.delete('/carousel/:id', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return R.badRequest(res, 'Invalid banner ID');
    await db.deleteFrom('dbo.carousel_banners').where('id', '=', id).execute();
    logger.info(`[Admin] Carousel banner ${id} deleted by admin ${req.admin.id}`);
    return R.ok(res, null, 'Banner deleted');
  } catch (err) { next(err); }
});

// =============================================================================
// PATCH /admin/carousel/:id
// =============================================================================
router.patch('/carousel/:id', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return R.badRequest(res, 'Invalid banner ID');
    const updates = {};
    if (typeof req.body.is_active === 'boolean') updates.is_active = req.body.is_active;
    if (typeof req.body.order     === 'number')  updates.order     = req.body.order;
    if (!Object.keys(updates).length) return R.badRequest(res, 'Nothing to update');
    updates.updated_at = sql`SYSUTCDATETIME()`;
    await db.updateTable('dbo.carousel_banners').set(updates).where('id', '=', id).execute();
    return R.ok(res, null, 'Banner updated');
  } catch (err) { next(err); }
});



router.get   ('/pay-services',     payServicesCtrl.getAllServices);
router.post  ('/pay-services',     payServicesCtrl.createService);
router.patch ('/pay-services/:id', payServicesCtrl.updateService);
router.delete('/pay-services/:id', payServicesCtrl.deleteService);
router.patch ('/pay-services/providers/:providerId', payServicesCtrl.updateProvider);
router.delete('/pay-services/providers/:providerId', payServicesCtrl.deleteProvider);
router.post  ('/pay-services/:id/providers',         payServicesCtrl.addProvider);


module.exports = router;