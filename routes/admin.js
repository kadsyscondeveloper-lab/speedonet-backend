// routes/admin.js
// ─────────────────────────────────────────────────────────────────────────────
// Mount this in routes/index.js:
//   router.use('/admin', require('./admin'));
// ─────────────────────────────────────────────────────────────────────────────

const router = require('express').Router();
const { db, sql } = require('../config/db');
const { authenticate, requireAdmin } = require('../middleware/auth');
const R = require('../utils/response');
const logger = require('../utils/logger');

// All admin routes require auth + admin role
router.use(authenticate, requireAdmin);

// =============================================================================
// GET /admin/stats  — overview numbers
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
// =============================================================================
router.get('/users', async (req, res, next) => {
  try {
    const page   = parseInt(req.query.page  || '1');
    const limit  = parseInt(req.query.limit || '15');
    const search = req.query.search?.trim() || '';
    const offset = (page - 1) * limit;

    let q = db.selectFrom('dbo.users as u')
      .leftJoin('dbo.kyc_submissions as k', (join) =>
        join.onRef('k.user_id', '=', 'u.id')
            .on('k.id', '=', sql`(SELECT TOP 1 id FROM dbo.kyc_submissions WHERE user_id=u.id ORDER BY submitted_at DESC)`)
      )
      .select(['u.id', 'u.name', 'u.phone', 'u.email', 'u.wallet_balance', 'u.is_active', 'u.created_at', 'k.status as kyc_status']);

    if (search) {
      q = q.where((eb) => eb.or([
        eb('u.name',  'like', `%${search}%`),
        eb('u.phone', 'like', `%${search}%`),
      ]));
    }

    const [users, countRow] = await Promise.all([
      q.orderBy('u.created_at', 'desc').limit(limit).offset(offset).execute(),
      db.selectFrom('dbo.users').select(db.fn.count('id').as('total'))
        .$if(!!search, qb => qb.where((eb) => eb.or([eb('name','like',`%${search}%`), eb('phone','like',`%${search}%`)])))
        .executeTakeFirstOrThrow(),
    ]);

    const total = Number(countRow.total);
    return R.ok(res, { users }, 'OK', 200, { page, limit, total, total_pages: Math.ceil(total / limit) });
  } catch (err) { next(err); }
});

// =============================================================================
// GET /admin/users/:id  — single user full detail
// =============================================================================
router.get('/users/:id', async (req, res, next) => {
  try {
    const userId = parseInt(req.params.id);
    const user = await db
      .selectFrom('dbo.users as u')
      .leftJoin('dbo.user_addresses as a', (j) => j.onRef('a.user_id','=','u.id').on('a.is_primary','=',true))
      .leftJoin('dbo.kyc_submissions as k', (j) =>
        j.onRef('k.user_id','=','u.id')
         .on('k.id', '=', sql`(SELECT TOP 1 id FROM dbo.kyc_submissions WHERE user_id=u.id ORDER BY submitted_at DESC)`)
      )
      .leftJoin('dbo.referral_codes as rc', 'rc.user_id', 'u.id')
      .select([
        'u.id','u.name','u.phone','u.email','u.wallet_balance','u.is_active','u.created_at',
        'a.house_no','a.address','a.city','a.state','a.pin_code',
        'k.status as kyc_status','k.submitted_at as kyc_submitted_at',
        'rc.code as referral_code',
      ])
      .where('u.id', '=', BigInt(userId))
      .executeTakeFirst();

    if (!user) return R.notFound(res, 'User not found');
    return R.ok(res, { user });
  } catch (err) { next(err); }
});

// =============================================================================
// GET /admin/kyc  — paginated KYC list
// =============================================================================
router.get('/kyc', async (req, res, next) => {
  try {
    const page   = parseInt(req.query.page   || '1');
    const limit  = parseInt(req.query.limit  || '12');
    const status = req.query.status || '';
    const offset = (page - 1) * limit;

    let q = db.selectFrom('dbo.kyc_submissions as k')
      .innerJoin('dbo.users as u', 'u.id', 'k.user_id')
      .select(['k.id','k.user_id','k.status','k.id_proof_type','k.address_proof_type','k.submitted_at','k.reviewed_at','k.rejection_reason','u.name as user_name','u.phone as user_phone']);

    if (status) q = q.where('k.status', '=', status);

    const [submissions, countRow] = await Promise.all([
      q.orderBy('k.submitted_at', 'desc').limit(limit).offset(offset).execute(),
      db.selectFrom('dbo.kyc_submissions')
        .$if(!!status, qb => qb.where('status','=',status))
        .select(db.fn.count('id').as('total')).executeTakeFirstOrThrow(),
    ]);

    const total = Number(countRow.total);
    return R.ok(res, { submissions }, 'OK', 200, { page, limit, total, total_pages: Math.ceil(total/limit) });
  } catch (err) { next(err); }
});

// =============================================================================
// GET /admin/kyc/:kycId  — single KYC with document data
// =============================================================================
router.get('/kyc/:kycId', async (req, res, next) => {
  try {
    const kycId = parseInt(req.params.kycId);
    const submission = await db
      .selectFrom('dbo.kyc_submissions as k')
      .innerJoin('dbo.users as u', 'u.id', 'k.user_id')
      .select(['k.id','k.user_id','k.status','k.id_proof_type','k.id_proof_data','k.id_proof_mime',
               'k.address_proof_type','k.address_proof_data','k.address_proof_mime',
               'k.rejection_reason','k.submitted_at','k.reviewed_at',
               'u.name as user_name','u.phone as user_phone'])
      .where('k.id', '=', BigInt(kycId))
      .executeTakeFirst();

    if (!submission) return R.notFound(res, 'KYC submission not found');
    return R.ok(res, { submission });
  } catch (err) { next(err); }
});

// =============================================================================
// PATCH /admin/kyc/:userId/:kycId  — approve / reject / update
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

    const notifMap = {
      approved:     { title: 'KYC Approved ✅', body: 'Your KYC verification is complete. You now have full access to all features.' },
      rejected:     { title: 'KYC Rejected ❌', body: rejection_reason ? `Your KYC was rejected: ${rejection_reason}. Please re-submit your documents.` : 'Your KYC was rejected. Please re-submit your documents.' },
      under_review: { title: 'KYC Under Review 🔍', body: "Your documents are being reviewed by our team. We'll notify you once complete." },
    };

    const notif = notifMap[status];
    if (notif) {
      await db.insertInto('dbo.notifications').values({
        user_id: BigInt(userId), type: 'kyc_status', title: notif.title, body: notif.body,
      }).execute();
    }

    logger.info(`[Admin] KYC ${kycId} → ${status} by admin ${req.user.id}`);
    return R.ok(res, null, `KYC status updated to '${status}'. User notified.`);
  } catch (err) { next(err); }
});

// =============================================================================
// GET /admin/payments  — paginated payment orders with user info
// =============================================================================
router.get('/payments', async (req, res, next) => {
  try {
    const page   = parseInt(req.query.page   || '1');
    const limit  = parseInt(req.query.limit  || '15');
    const status = req.query.status || '';
    const offset = (page - 1) * limit;

    const [orders, countRow] = await Promise.all([
      sql`
        SELECT po.id, po.order_ref, po.type, po.total_amount, po.payment_method,
               po.payment_status, po.gateway_name, po.created_at,
               u.name as user_name, u.phone as user_phone
        FROM dbo.payment_orders po
        INNER JOIN dbo.users u ON u.id = po.user_id
        ${status ? sql`WHERE po.payment_status = ${status}` : sql``}
        ORDER BY po.created_at DESC
        OFFSET ${offset} ROWS FETCH NEXT ${limit} ROWS ONLY
      `.execute(db).then(r => r.rows),
      db.selectFrom('dbo.payment_orders')
        .$if(!!status, qb => qb.where('payment_status','=',status))
        .select(db.fn.count('id').as('total')).executeTakeFirstOrThrow(),
    ]);

    const total = Number(countRow.total);
    return R.ok(res, { orders }, 'OK', 200, { page, limit, total, total_pages: Math.ceil(total/limit) });
  } catch (err) { next(err); }
});

// =============================================================================
// GET /admin/subscriptions  — recent subscriptions with user + plan
// =============================================================================
router.get('/subscriptions', async (req, res, next) => {
  try {
    const limit = parseInt(req.query.limit || '20');
    const subscriptions = await sql`
      SELECT s.id, s.status, s.start_date, s.expires_at,
             u.name as user_name, u.phone as user_phone,
             p.name as plan_name, p.speed_mbps
      FROM dbo.user_subscriptions s
      INNER JOIN dbo.users u ON u.id = s.user_id
      INNER JOIN dbo.broadband_plans p ON p.id = s.plan_id
      ORDER BY s.created_at DESC
      OFFSET 0 ROWS FETCH NEXT ${limit} ROWS ONLY
    `.execute(db).then(r => r.rows);

    return R.ok(res, { subscriptions });
  } catch (err) { next(err); }
});

// =============================================================================
// GET /admin/tickets  — all tickets with user info
// =============================================================================
router.get('/tickets', async (req, res, next) => {
  try {
    const page   = parseInt(req.query.page   || '1');
    const limit  = parseInt(req.query.limit  || '15');
    const status = req.query.status || '';
    const offset = (page - 1) * limit;

    const [tickets, countRow] = await Promise.all([
      sql`
        SELECT t.id, t.ticket_number, t.category, t.subject,
               t.status, t.priority, t.created_at, t.updated_at,
               u.name as user_name, u.phone as user_phone
        FROM dbo.help_tickets t
        INNER JOIN dbo.users u ON u.id = t.user_id
        ${status ? sql`WHERE t.status = ${status}` : sql``}
        ORDER BY t.created_at DESC
        OFFSET ${offset} ROWS FETCH NEXT ${limit} ROWS ONLY
      `.execute(db).then(r => r.rows),
      db.selectFrom('dbo.help_tickets')
        .$if(!!status, qb => qb.where('status','=',status))
        .select(db.fn.count('id').as('total')).executeTakeFirstOrThrow(),
    ]);

    const total = Number(countRow.total);
    return R.ok(res, { tickets }, 'OK', 200, { page, limit, total, total_pages: Math.ceil(total/limit) });
  } catch (err) { next(err); }
});

// =============================================================================
// GET /admin/tickets/:id  — single ticket with all replies
// =============================================================================
router.get('/tickets/:id', async (req, res, next) => {
  try {
    const ticketId = parseInt(req.params.id);
    const ticket = await db.selectFrom('dbo.help_tickets as t')
      .innerJoin('dbo.users as u', 'u.id', 't.user_id')
      .select(['t.id','t.ticket_number','t.category','t.subject','t.description','t.status','t.priority','t.resolved_at','t.created_at','t.updated_at','u.name as user_name','u.phone as user_phone'])
      .where('t.id', '=', BigInt(ticketId))
      .executeTakeFirst();

    if (!ticket) return R.notFound(res, 'Ticket not found');

    const replies = await db.selectFrom('dbo.ticket_replies')
      .select(['id','sender_id','sender_type','message','created_at'])
      .where('ticket_id', '=', BigInt(ticketId))
      .orderBy('created_at', 'asc')
      .execute();

    return R.ok(res, { ticket: { ...ticket, replies } });
  } catch (err) { next(err); }
});

// =============================================================================
// POST /admin/tickets/:id/reply  — admin reply to ticket
// =============================================================================
router.post('/tickets/:id/reply', async (req, res, next) => {
  try {
    const ticketId = parseInt(req.params.id);
    const { message } = req.body;
    if (!message?.trim()) return R.badRequest(res, 'Message is required');

    const ticket = await db.selectFrom('dbo.help_tickets').select(['id','status','user_id'])
      .where('id', '=', BigInt(ticketId)).executeTakeFirst();
    if (!ticket) return R.notFound(res, 'Ticket not found');
    if (ticket.status === 'closed') return R.badRequest(res, 'Ticket is closed');

    await db.insertInto('dbo.ticket_replies').values({
      ticket_id: BigInt(ticketId), sender_id: BigInt(req.user.id),
      sender_type: 'admin', message,
    }).execute();

    await db.updateTable('dbo.help_tickets')
      .set({ updated_at: sql`SYSUTCDATETIME()` })
      .where('id', '=', BigInt(ticketId)).execute();

    // Notify user
    await db.insertInto('dbo.notifications').values({
      user_id: ticket.user_id, type: 'support_ticket',
      title: 'Support Reply Received 💬',
      body: `An admin has replied to your ticket. Check the app for details.`,
    }).execute();

    return R.ok(res, null, 'Reply sent');
  } catch (err) { next(err); }
});

// =============================================================================
// PATCH /admin/tickets/:id/status  — update ticket status
// =============================================================================
router.patch('/tickets/:id/status', async (req, res, next) => {
  try {
    const ticketId = parseInt(req.params.id);
    const { status } = req.body;
    const valid = ['open','in_progress','resolved','closed'];
    if (!valid.includes(status)) return R.badRequest(res, 'Invalid status');
    const updates = { status, updated_at: sql`SYSUTCDATETIME()` };
    if (status === 'resolved' || status === 'closed') updates.resolved_at = new Date();
    await db.updateTable('dbo.help_tickets').set(updates).where('id','=',BigInt(ticketId)).execute();
    return R.ok(res, null, `Ticket marked ${status}`);
  } catch (err) { next(err); }
});

// =============================================================================
// GET /admin/notifications  — recent notifications (all users)
// =============================================================================
router.get('/notifications', async (req, res, next) => {
  try {
    const limit = parseInt(req.query.limit || '20');
    const notifications = await sql`
      SELECT n.id, n.title, n.body, n.type, n.created_at,
             u.name as user_name, u.phone as user_phone
      FROM dbo.notifications n
      INNER JOIN dbo.users u ON u.id = n.user_id
      ORDER BY n.created_at DESC
      OFFSET 0 ROWS FETCH NEXT ${limit} ROWS ONLY
    `.execute(db).then(r => r.rows);

    return R.ok(res, { notifications });
  } catch (err) { next(err); }
});

// =============================================================================
// POST /admin/notifications/send  — send to one user or broadcast
// =============================================================================
router.post('/notifications/send', async (req, res, next) => {
  try {
    const { phone, broadcast, type = 'general', title, body } = req.body;
    if (!title?.trim() || !body?.trim()) return R.badRequest(res, 'Title and body are required');

    if (broadcast) {
      // Insert for all active users in batches
      const users = await db.selectFrom('dbo.users').select('id').where('is_active','=',true).execute();
      const values = users.map(u => ({ user_id: u.id, type, title, body }));
      // Insert in chunks of 100
      for (let i = 0; i < values.length; i += 100) {
        await db.insertInto('dbo.notifications').values(values.slice(i, i + 100)).execute();
      }
      logger.info(`[Admin] Broadcast notification sent to ${users.length} users by admin ${req.user.id}`);
      return R.ok(res, { sent_to: users.length }, `Broadcast sent to ${users.length} users`);
    }

    if (!phone) return R.badRequest(res, 'Phone number is required for targeted notification');
    const user = await db.selectFrom('dbo.users').select(['id','name']).where('phone','=',phone).executeTakeFirst();
    if (!user) return R.notFound(res, 'No user found with that phone number');

    await db.insertInto('dbo.notifications').values({ user_id: user.id, type, title, body }).execute();
    logger.info(`[Admin] Notification sent to user ${user.id} by admin ${req.user.id}`);
    return R.ok(res, null, `Notification sent to ${user.name}`);
  } catch (err) { next(err); }
});

// =============================================================================
// DELETE /carousels/:id  — delete a banner (add to routes/carousels.js)
// =============================================================================
router.delete('/carousel/:id', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id);
    await db.deleteFrom('dbo.carousel_banners').where('id','=',id).execute();
    return R.ok(res, null, 'Banner deleted');
  } catch (err) { next(err); }
});

module.exports = router;