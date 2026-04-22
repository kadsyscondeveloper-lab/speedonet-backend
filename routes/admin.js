// routes/admin.js
const router = require('express').Router();
const { db, sql } = require('../config/db');
const { authenticateAdmin } = require('../middleware/adminAuth');
const R = require('../utils/response');
const logger = require('../utils/logger');
const payServicesCtrl = require('../controllers/payServicesController');
const notifyUser = require('../utils/notifyUser');
const { broadcast } = require('../services/fcmService');
const bcryptForTech = require('bcryptjs');
const { _onInstallationCompleted } = require('../controllers/installationController');
const ticketJobCtrl = require('../controllers/ticketJobController');
const { param } = require('express-validator');
const { validate } = require('../middleware/validators');

router.use(authenticateAdmin);
const { adminLimiter } = require('../middleware/errorHandler');
router.use(adminLimiter);

// =============================================================================
// GET /admin/stats
// =============================================================================
router.get('/stats', async (req, res, next) => {
  try {
    const [userCount, kycPending, activeSubs, revenueToday, techJobsActive] = await Promise.all([
      db.selectFrom('dbo.users').select(db.fn.count('id').as('n')).executeTakeFirstOrThrow(),
      db.selectFrom('dbo.kyc_submissions').select(db.fn.count('id').as('n')).where('status', '=', 'pending').executeTakeFirstOrThrow(),
      db.selectFrom('dbo.user_subscriptions').select(db.fn.count('id').as('n')).where('status', '=', 'active').where('expires_at', '>=', sql`CAST(SYSDATETIME() AS DATE)`).executeTakeFirstOrThrow(),
      sql`SELECT ISNULL(SUM(CAST(total_amount AS DECIMAL(12,2))),0) AS n FROM dbo.payment_orders WHERE payment_status='success' AND CAST(paid_at AS DATE)=CAST(SYSDATETIME() AS DATE)`.execute(db).then(r => r.rows[0]),
      sql`SELECT COUNT(id) AS n FROM dbo.help_tickets WHERE tech_job_status IN ('open', 'assigned')`.execute(db).then(r => r.rows[0]),
    ]);

    return R.ok(res, {
      total_users:       Number(userCount.n),
      pending_kyc:       Number(kycPending.n),
      active_subs:       Number(activeSubs.n),
      revenue_today:     Number(revenueToday.n || 0).toFixed(2),
      tech_jobs_active:  Number(techJobsActive.n || 0),
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
          t.tech_job_status, t.requires_technician,
          t.job_opened_at, t.job_assigned_at, t.job_completed_at,
          u.name AS user_name, u.phone AS user_phone,
          tech.name  AS technician_name,
          tech.phone AS technician_phone
        FROM dbo.help_tickets t
        INNER JOIN dbo.users u ON u.id = t.user_id
        LEFT JOIN dbo.technicians tech ON tech.id = t.assigned_technician_id
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
        t.tech_job_status, t.requires_technician,
        t.job_opened_at, t.job_assigned_at, t.job_completed_at,
        u.name AS user_name, u.phone AS user_phone,
        tech.name  AS technician_name,
        tech.phone AS technician_phone,
        tech.employee_id AS technician_employee_id
      FROM dbo.help_tickets t
      INNER JOIN dbo.users u ON u.id = t.user_id
      LEFT JOIN dbo.technicians tech ON tech.id = t.assigned_technician_id
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


router.patch(
  '/tickets/:id/publish-job',
  [
    param('id').isInt({ min: 1 }).withMessage('Ticket ID must be a positive integer'),
    validate,
  ],
  ticketJobCtrl.adminPublishJob,
);
 
// PATCH /api/v1/admin/tickets/:id/unpublish-job
//   → Retracts the job (only works if not yet grabbed by a technician)
router.patch(
  '/tickets/:id/unpublish-job',
  [
    param('id').isInt({ min: 1 }).withMessage('Ticket ID must be a positive integer'),
    validate,
  ],
  ticketJobCtrl.adminUnpublishJob,
);

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

    await notifyUser(db, Number(user.id), { type, title, body });
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



// ── Service Areas ─────────────────────────────────────────────────────────────
router.get('/service-areas', async (req, res, next) => {
  try {
    const rows = await db.selectFrom('dbo.service_areas').selectAll()
      .orderBy('created_at', 'desc').execute();
    return R.ok(res, { areas: rows });
  } catch (err) { next(err); }
});

router.post('/service-areas', async (req, res, next) => {
  try {
    const { pin_code, area_name, city, state } = req.body;
    if (!pin_code?.trim()) return R.badRequest(res, 'pin_code is required.');
    const row = await db.insertInto('dbo.service_areas')
      .values({ pin_code: pin_code.trim(), area_name, city, state })
      .output(['inserted.id', 'inserted.pin_code', 'inserted.area_name', 'inserted.city'])
      .executeTakeFirstOrThrow();
    return R.created(res, { area: row }, 'Service area added.');
  } catch (err) {
    if (err.number === 2627) return R.conflict(res, 'This PIN code already exists.');
    next(err);
  }
});

router.patch('/service-areas/:id', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id);
    const allowed = {};
    if (req.body.area_name != null)              allowed.area_name = req.body.area_name;
    if (req.body.city      != null)              allowed.city      = req.body.city;
    if (typeof req.body.is_active === 'boolean') allowed.is_active = req.body.is_active;
    if (!Object.keys(allowed).length) return R.badRequest(res, 'Nothing to update.');
    allowed.updated_at = sql`SYSUTCDATETIME()`;
    await db.updateTable('dbo.service_areas').set(allowed).where('id', '=', id).execute();
    return R.ok(res, null, 'Service area updated.');
  } catch (err) { next(err); }
});

router.delete('/service-areas/:id', async (req, res, next) => {
  try {
    await db.deleteFrom('dbo.service_areas').where('id', '=', parseInt(req.params.id)).execute();
    return R.ok(res, null, 'Service area deleted.');
  } catch (err) { next(err); }
});

// ── Availability Inquiries ────────────────────────────────────────────────────

router.get('/availability-inquiries', async (req, res, next) => {
  try {
    const page   = Math.max(1, parseInt(req.query.page   || '1'));
    const limit  = Math.max(1, parseInt(req.query.limit  || '15'));
    const status = req.query.status || '';  // filter: pending / available / unavailable
    const offset = (page - 1) * limit;

    const [rows, countRow] = await Promise.all([
      sql`
        SELECT *
        FROM dbo.availability_inquiries
        ${status ? sql`WHERE status = ${status}` : sql``}
        ORDER BY created_at DESC
        OFFSET ${offset} ROWS FETCH NEXT ${limit} ROWS ONLY
      `.execute(db).then(r => r.rows),

      status
        ? sql`SELECT COUNT(id) AS total FROM dbo.availability_inquiries
              WHERE status = ${status}`.execute(db).then(r => r.rows[0])
        : db.selectFrom('dbo.availability_inquiries')
            .select(db.fn.count('id').as('total'))
            .executeTakeFirstOrThrow(),
    ]);

    const total = Number(countRow.total);
    return R.ok(res, { inquiries: rows }, 'OK', 200,
      { page, limit, total, total_pages: Math.ceil(total / limit) });
  } catch (err) { next(err); }
});

// PATCH /admin/availability-inquiries/:id
// Admin responds: { status: 'available' | 'unavailable', admin_notes?: string }
router.patch('/availability-inquiries/:id', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return R.badRequest(res, 'Invalid inquiry ID.');

    const { status, admin_notes } = req.body;
    const VALID = ['available', 'unavailable'];
    if (!VALID.includes(status))
      return R.badRequest(res, "status must be 'available' or 'unavailable'.");

    const inquiry = await db
      .selectFrom('dbo.availability_inquiries')
      .select(['id', 'phone', 'name', 'status'])
      .where('id', '=', id)
      .executeTakeFirst();

    if (!inquiry) return R.notFound(res, 'Inquiry not found.');
    if (inquiry.status !== 'pending')
      return R.badRequest(res, 'This inquiry has already been responded to.');

    await db
      .updateTable('dbo.availability_inquiries')
      .set({
        status,
        admin_notes:  admin_notes?.trim() || null,
        responded_at: new Date(),
        responded_by: req.admin.id,
      })
      .where('id', '=', id)
      .execute();


    if (status === 'available') {
        await db
          .updateTable('dbo.users')
          .set({ availability_confirmed: true, updated_at: sql`SYSUTCDATETIME()` })
          .where('phone', '=', inquiry.phone)
          .execute();
}

    // Notify the user if they have an account with this phone number
    // Notify if they have an account
  const user = await db
    .selectFrom('dbo.users')
    .select('id')
    .where('phone', '=', inquiry.phone)
    .executeTakeFirst();

  if (user) {
    const isAvailable = status === 'available';
    await notifyUser(db, Number(user.id), {
      type:  'availability',
      title: isAvailable
        ? 'Great News! Service Available 🎉'
        : 'Service Availability Update',
      body: isAvailable
        ? `Speedonet is available in your area! Open the app to complete your profile and get started.`
        : `Unfortunately, service is not yet available in your area. ${admin_notes || "We'll keep expanding and notify you!"}`,
      data: { inquiry_status: status },
    });
  }

    logger.info(
      `[Admin] Inquiry ${id} responded: ${status} by admin ${req.admin.id}`
    );
    return R.ok(res, null,
      `Inquiry marked as '${status}'${user ? ' and user notified.' : '.'}`);
  } catch (err) { next(err); }
});


// ── GET /admin/technicians  — paginated list ──────────────────────────────────
router.get('/technicians', async (req, res, next) => {
  try {
    const page   = Math.max(1, parseInt(req.query.page  || '1'));
    const limit  = Math.max(1, parseInt(req.query.limit || '15'));
    const search = req.query.search?.trim() || '';
    const offset = (page - 1) * limit;
 
    const [techs, countRow] = await Promise.all([
      sql`
        SELECT
          t.id, t.name, t.phone, t.employee_id, t.email,
          t.is_active, t.current_load, t.created_at,
          COUNT(ir.id) AS total_jobs,
          SUM(CASE WHEN ir.status = 'completed' THEN 1 ELSE 0 END) AS completed_jobs
        FROM dbo.technicians t
        LEFT JOIN dbo.installation_requests ir ON ir.assigned_technician_id = t.id
        ${search
          ? sql`WHERE t.name LIKE ${'%'+search+'%'} OR t.phone LIKE ${'%'+search+'%'} OR t.employee_id LIKE ${'%'+search+'%'}`
          : sql``}
        GROUP BY t.id, t.name, t.phone, t.employee_id, t.email, t.is_active, t.current_load, t.created_at
        ORDER BY t.created_at DESC
        OFFSET ${offset} ROWS FETCH NEXT ${limit} ROWS ONLY
      `.execute(db).then(r => r.rows),
 
      search
        ? sql`SELECT COUNT(id) AS total FROM dbo.technicians
              WHERE name LIKE ${'%'+search+'%'} OR phone LIKE ${'%'+search+'%'} OR employee_id LIKE ${'%'+search+'%'}`.execute(db).then(r => r.rows[0])
        : db.selectFrom('dbo.technicians').select(db.fn.count('id').as('total')).executeTakeFirstOrThrow(),
    ]);
 
    const total = Number(countRow.total);
    return R.ok(res, { technicians: techs }, 'OK', 200,
      { page, limit, total, total_pages: Math.ceil(total / limit) });
  } catch (err) { next(err); }
});
 
// ── GET /admin/technicians/:id ────────────────────────────────────────────────
router.get('/technicians/:id', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return R.badRequest(res, 'Invalid technician ID.');
 
    const tech = await sql`
      SELECT
        t.id, t.name, t.phone, t.employee_id, t.email,
        t.is_active, t.current_load, t.created_at,
        COUNT(ir.id) AS total_jobs,
        SUM(CASE WHEN ir.status = 'completed'   THEN 1 ELSE 0 END) AS completed_jobs,
        SUM(CASE WHEN ir.status = 'in_progress' THEN 1 ELSE 0 END) AS active_jobs
      FROM dbo.technicians t
      LEFT JOIN dbo.installation_requests ir ON ir.assigned_technician_id = t.id
      WHERE t.id = ${BigInt(id)}
      GROUP BY t.id, t.name, t.phone, t.employee_id, t.email, t.is_active, t.current_load, t.created_at
    `.execute(db).then(r => r.rows[0]);
 
    if (!tech) return R.notFound(res, 'Technician not found.');
 
    // Recent assignments
    const recentJobs = await sql`
      SELECT TOP 10
        ir.id, ir.request_number, ir.status, ir.city,
        ir.assigned_at, ir.completed_at,
        u.name AS customer_name
      FROM dbo.installation_requests ir
      INNER JOIN dbo.users u ON u.id = ir.user_id
      WHERE ir.assigned_technician_id = ${BigInt(id)}
      ORDER BY ir.assigned_at DESC
    `.execute(db).then(r => r.rows);
 
    return R.ok(res, { technician: { ...tech, recent_jobs: recentJobs } });
  } catch (err) { next(err); }
});
 
// ── POST /admin/technicians  — create technician ──────────────────────────────
router.post('/technicians', async (req, res, next) => {
  try {
    const { name, phone, employee_id, email, password } = req.body;
 
    if (!name?.trim() || !phone?.trim() || !employee_id?.trim() || !password)
      return R.badRequest(res, 'name, phone, employee_id and password are required.');
    if (password.length < 8)
      return R.badRequest(res, 'Password must be at least 8 characters.');
 
    const hash = await bcryptForTech.hash(
      password, parseInt(process.env.BCRYPT_ROUNDS || '12')
    );
 
    const row = await db
      .insertInto('dbo.technicians')
      .values({
        name:          name.trim(),
        phone:         phone.trim(),
        employee_id:   employee_id.trim(),
        email:         email?.trim() || null,
        password_hash: hash,
      })
      .output(['inserted.id', 'inserted.name', 'inserted.phone',
               'inserted.employee_id', 'inserted.email', 'inserted.is_active'])
      .executeTakeFirstOrThrow();
 
    logger.info(`[Admin] Technician created: ${row.phone} by admin ${req.admin.id}`);
    return R.created(res,
      { technician: { ...row, id: Number(row.id) } },
      'Technician account created.');
  } catch (err) {
    if (err.number === 2627 || err.number === 2601)
      return R.conflict(res, 'Phone or employee ID already exists.');
    next(err);
  }
});
 
// ── PATCH /admin/technicians/:id  — update details / toggle active ────────────
router.patch('/technicians/:id', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return R.badRequest(res, 'Invalid technician ID.');
 
    const allowed = {};
    if (req.body.name        != null) allowed.name        = req.body.name.trim();
    if (req.body.phone       != null) allowed.phone       = req.body.phone.trim();
    if (req.body.employee_id != null) allowed.employee_id = req.body.employee_id.trim();
    if (req.body.email       != null) allowed.email       = req.body.email.trim();
    if (typeof req.body.is_active === 'boolean') allowed.is_active = req.body.is_active;
 
    // Allow admin to reset password
    if (req.body.new_password) {
      if (req.body.new_password.length < 8)
        return R.badRequest(res, 'Password must be at least 8 characters.');
      allowed.password_hash = await bcryptForTech.hash(
        req.body.new_password, parseInt(process.env.BCRYPT_ROUNDS || '12')
      );
    }
 
    if (!Object.keys(allowed).length) return R.badRequest(res, 'Nothing to update.');
    allowed.updated_at = sql`SYSUTCDATETIME()`;
 
    await db.updateTable('dbo.technicians')
      .set(allowed)
      .where('id', '=', BigInt(id))
      .execute();
 
    logger.info(`[Admin] Technician ${id} updated by admin ${req.admin.id}`);
    return R.ok(res, null, 'Technician updated.');
  } catch (err) {
    if (err.number === 2627 || err.number === 2601)
      return R.conflict(res, 'Phone or employee ID already in use.');
    next(err);
  }
});
 
// ── DELETE /admin/technicians/:id  — soft-deactivate only ────────────────────
router.delete('/technicians/:id', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return R.badRequest(res, 'Invalid technician ID.');
 
    // Safety: don't deactivate if they have active jobs
    const activeJobs = await db
      .selectFrom('dbo.installation_requests')
      .select(db.fn.count('id').as('n'))
      .where('assigned_technician_id', '=', BigInt(id))
      .where('status', 'in', ['assigned', 'in_progress'])
      .executeTakeFirstOrThrow();
 
    if (Number(activeJobs.n) > 0)
      return R.badRequest(res,
        `Cannot deactivate — technician has ${activeJobs.n} active job(s). Reassign them first.`);
 
    await db.updateTable('dbo.technicians')
      .set({ is_active: false, updated_at: sql`SYSUTCDATETIME()` })
      .where('id', '=', BigInt(id))
      .execute();
 
    logger.info(`[Admin] Technician ${id} deactivated by admin ${req.admin.id}`);
    return R.ok(res, null, 'Technician deactivated.');
  } catch (err) { next(err); }
});
 
// =============================================================================
// INSTALLATION REQUEST MANAGEMENT (enhanced with technician assignment)
// =============================================================================
 
// ── GET /admin/installations  — all requests with filters ────────────────────
router.get('/installations', async (req, res, next) => {
  try {
    const page   = Math.max(1, parseInt(req.query.page  || '1'));
    const limit  = Math.max(1, parseInt(req.query.limit || '15'));
    const status = req.query.status || '';
    const offset = (page - 1) * limit;
 
    const [rows, countRow] = await Promise.all([
      sql`
        SELECT
          ir.id, ir.request_number, ir.status,
          ir.city, ir.pin_code, ir.scheduled_at,
          ir.assigned_at, ir.assigned_by, ir.completed_at, ir.created_at,
          u.name  AS customer_name,
          u.phone AS customer_phone,
          t.name  AS technician_name,
          t.phone AS technician_phone,
          t.employee_id AS technician_employee_id
        FROM dbo.installation_requests ir
        INNER JOIN dbo.users u ON u.id = ir.user_id
        LEFT JOIN dbo.technicians t ON t.id = ir.assigned_technician_id
        ${status ? sql`WHERE ir.status = ${status}` : sql``}
        ORDER BY ir.created_at DESC
        OFFSET ${offset} ROWS FETCH NEXT ${limit} ROWS ONLY
      `.execute(db).then(r => r.rows),
 
      status
        ? sql`SELECT COUNT(id) AS total FROM dbo.installation_requests WHERE status = ${status}`.execute(db).then(r => r.rows[0])
        : db.selectFrom('dbo.installation_requests').select(db.fn.count('id').as('total')).executeTakeFirstOrThrow(),
    ]);
 
    const total = Number(countRow.total);
    return R.ok(res, { installations: rows }, 'OK', 200,
      { page, limit, total, total_pages: Math.ceil(total / limit) });
  } catch (err) { next(err); }
});
 
// ── GET /admin/installations/:id ──────────────────────────────────────────────
router.get('/installations/:id', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return R.badRequest(res, 'Invalid installation ID.');
 
    const row = await sql`
      SELECT
        ir.*,
        u.name  AS customer_name,  u.phone AS customer_phone,
        t.id    AS technician_id,  t.name  AS technician_name,
        t.phone AS technician_phone, t.employee_id AS technician_employee_id
      FROM dbo.installation_requests ir
      INNER JOIN dbo.users u     ON u.id = ir.user_id
      LEFT  JOIN dbo.technicians t ON t.id = ir.assigned_technician_id
      WHERE ir.id = ${BigInt(id)}
    `.execute(db).then(r => r.rows[0]);
 
    if (!row) return R.notFound(res, 'Installation request not found.');
 
    // Assignment history
    const history = await sql`
      SELECT
        ta.created_at AS assigned_at, ta.assigned_by_type,
        ta.unassigned_at, ta.unassigned_reason,
        t.name AS technician_name, t.employee_id
      FROM dbo.technician_assignments ta
      INNER JOIN dbo.technicians t ON t.id = ta.technician_id
      WHERE ta.installation_id = ${BigInt(id)}
      ORDER BY ta.created_at ASC
    `.execute(db).then(r => r.rows);
 
    return R.ok(res, { installation: { ...row, assignment_history: history } });
  } catch (err) { next(err); }
});
 
// ── POST /admin/installations/:id/assign  — admin assigns a technician ────────
router.post('/installations/:id/assign', async (req, res, next) => {
  try {
    const id           = parseInt(req.params.id);
    const technicianId = parseInt(req.body.technician_id);
    if (isNaN(id) || isNaN(technicianId))
      return R.badRequest(res, 'installation id and technician_id are required.');
 
    const [request, tech] = await Promise.all([
      db.selectFrom('dbo.installation_requests')
        .select(['id', 'status', 'assigned_technician_id', 'user_id', 'request_number'])
        .where('id', '=', BigInt(id))
        .executeTakeFirst(),
 
      db.selectFrom('dbo.technicians')
        .select(['id', 'name', 'is_active'])
        .where('id', '=', BigInt(technicianId))
        .executeTakeFirst(),
    ]);
 
    if (!request) return R.notFound(res, 'Installation request not found.');
    if (!tech || !tech.is_active) return R.notFound(res, 'Technician not found or inactive.');
    if (['completed', 'cancelled'].includes(request.status))
      return R.badRequest(res, 'Cannot assign a completed or cancelled request.');
 
    const now = new Date();
 
    // If previously assigned, close out old assignment record
    if (request.assigned_technician_id) {
      await db.updateTable('dbo.technician_assignments')
        .set({
          unassigned_at:     now,
          unassigned_reason: 'Reassigned by admin',
        })
        .where('installation_id', '=', BigInt(id))
        .where('unassigned_at',   'is', null)
        .execute();
 
      // Decrement old technician's load
      await db.updateTable('dbo.technicians')
        .set({ current_load: sql`CASE WHEN current_load > 0 THEN current_load - 1 ELSE 0 END` })
        .where('id', '=', request.assigned_technician_id)
        .execute();
    }
 
    // Assign
    await db.updateTable('dbo.installation_requests')
      .set({
        assigned_technician_id: BigInt(technicianId),
        assigned_at:            now,
        assigned_by:            'admin',
        status:                 'assigned',
      })
      .where('id', '=', BigInt(id))
      .execute();
 
    await db.insertInto('dbo.technician_assignments').values({
      installation_id:  BigInt(id),
      technician_id:    BigInt(technicianId),
      assigned_by_type: 'admin',
      assigned_by_id:   BigInt(req.admin.id),
    }).execute();
 
    // Increment new technician's load
    await db.updateTable('dbo.technicians')
      .set({ current_load: sql`current_load + 1` })
      .where('id', '=', BigInt(technicianId))
      .execute();
 
    // Notify customer
    await notifyUser(db, Number(request.user_id), {
      type:  'installation',
      title: 'Technician Assigned 🔧',
      body:  `A technician has been assigned to your installation request ${request.request_number}. They will contact you shortly.`,
      data:  { request_number: request.request_number },
    });
 
    logger.info(`[Admin] Install ${id} → tech ${technicianId} by admin ${req.admin.id}`);
    return R.ok(res, null, `Installation assigned to ${tech.name}.`);
  } catch (err) { next(err); }
});
 
// ── PATCH /admin/installations/:id/status  — override status ─────────────────
router.patch('/installations/:id/status', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return R.badRequest(res, 'Invalid ID.');
 
    const { status, notes } = req.body;
    const VALID = ['pending', 'assigned', 'in_progress', 'completed', 'cancelled'];
    if (!VALID.includes(status))
      return R.badRequest(res, `Status must be one of: ${VALID.join(', ')}`);
 
    // Fetch request before updating so we have user_id + request_number
    const request = await db
      .selectFrom('dbo.installation_requests')
      .select(['id', 'user_id', 'request_number', 'assigned_technician_id'])
      .where('id', '=', BigInt(id))
      .executeTakeFirst();
 
    if (!request) return R.notFound(res, 'Installation request not found.');
 
    const updates = { status };
    if (notes?.trim()) updates.notes = notes.trim();
    if (status === 'completed') updates.completed_at = new Date();
 
    await db.updateTable('dbo.installation_requests')
      .set(updates)
      .where('id', '=', BigInt(id))
      .execute();
 
    // Decrement tech load on cancel
    if (status === 'cancelled' && request.assigned_technician_id) {
      await db.updateTable('dbo.technicians')
        .set({ current_load: sql`CASE WHEN current_load > 0 THEN current_load - 1 ELSE 0 END` })
        .where('id', '=', request.assigned_technician_id)
        .execute();
    }
 
    // ── NEW: activate pending plan when installation is marked completed ──
    if (status === 'completed') {
      await _onInstallationCompleted(Number(request.user_id), request.request_number);
    }
 
    logger.info(`[Admin] Installation ${id} → ${status} by admin ${req.admin.id}`);
    return R.ok(res, null, `Installation marked as '${status}'.`);
  } catch (err) { next(err); }
});


// GET /admin/technicians/:id/location
router.get('/technicians/:id/location', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return R.badRequest(res, 'Invalid technician ID.');

    const loc = await sql`
      SELECT
        tll.lat        AS latitude,
        tll.lng        AS longitude,
        tll.updated_at,
        tll.ticket_id,
        -- is_on_job: true if they have any assigned/in-progress ticket right now
        CASE WHEN ht.id IS NOT NULL THEN CAST(1 AS BIT) ELSE CAST(0 AS BIT) END AS is_on_job
      FROM dbo.technician_live_locations tll
      LEFT JOIN dbo.help_tickets ht
        ON ht.id = tll.ticket_id
       AND ht.tech_job_status = 'assigned'
      WHERE tll.technician_id = ${BigInt(id)}
      ORDER BY tll.updated_at DESC
      OFFSET 0 ROWS FETCH NEXT 1 ROWS ONLY
    `.execute(db).then(r => r.rows[0]);

    return R.ok(res, { location: loc || null });
  } catch (err) { next(err); }
});


router.get('/users/deactivated', async (req, res, next) => {
  try {
    const limit  = Math.max(1, Math.min(50, parseInt(req.query.limit || '20')));
    const offset = (Math.max(1, parseInt(req.query.page || '1')) - 1) * limit;
 
    const [users, countRow] = await Promise.all([
      sql`
        SELECT
          u.id, u.name, u.phone, u.email,
          u.is_active, u.deletion_requested_at, u.updated_at, u.created_at
        FROM dbo.users u
        WHERE u.is_active = 0
        ORDER BY u.updated_at DESC
        OFFSET ${offset} ROWS FETCH NEXT ${limit} ROWS ONLY
      `.execute(db).then(r => r.rows),
 
      sql`SELECT COUNT(id) AS total FROM dbo.users WHERE is_active = 0`
        .execute(db).then(r => r.rows[0]),
    ]);
 
    const total = Number(countRow.total);
    return R.ok(res, { users }, 'OK', 200,
      { limit, total, total_pages: Math.ceil(total / limit) });
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