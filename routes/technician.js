/**
 * routes/technician.js
 *
 * All technician-facing API routes (their "app" endpoints).
 * Protected by authenticateTechnician middleware.
 *
 * Mount in routes/index.js:
 *   router.use('/technician', require('./technician'));
 */

const router = require('express').Router();
const { db, sql } = require('../config/db');
const { authenticateTechnician } = require('../middleware/technicianAuth');
const notifyUser = require('../utils/notifyUser');
const R          = require('../utils/response');
const logger     = require('../utils/logger');
const { _onInstallationCompleted } = require('../controllers/installationController');

router.use(authenticateTechnician);

// ─────────────────────────────────────────────────────────────────────────────
// Helper: format installation row for technician response
// ─────────────────────────────────────────────────────────────────────────────

function formatJob(row) {
  return {
    id:             Number(row.id),
    request_number: row.request_number,
    status:         row.status,
    house_no:       row.house_no,
    address:        row.address,
    city:           row.city,
    state:          row.state,
    pin_code:       row.pin_code,
    notes:          row.notes,
    scheduled_at:   row.scheduled_at,
    completed_at:   row.completed_at,
    assigned_at:    row.assigned_at,
    assigned_by:    row.assigned_by,
    created_at:     row.created_at,
    customer: {
      name:  row.customer_name,
      phone: row.customer_phone,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /technician/jobs/open
// All unassigned pending requests — technician can browse and self-assign
// ─────────────────────────────────────────────────────────────────────────────
router.get('/jobs/open', async (req, res, next) => {
  try {
    const page  = Math.max(1, parseInt(req.query.page  || '1'));
    const limit = Math.max(1, parseInt(req.query.limit || '20'));
    const offset = (page - 1) * limit;

    const [rows, countRow] = await Promise.all([
      sql`
        SELECT
          ir.id, ir.request_number, ir.status,
          ir.house_no, ir.address, ir.city, ir.state, ir.pin_code,
          ir.notes, ir.scheduled_at, ir.created_at,
          u.name  AS customer_name,
          u.phone AS customer_phone
        FROM dbo.installation_requests ir
        INNER JOIN dbo.users u ON u.id = ir.user_id
        WHERE ir.status = 'pending'
          AND ir.assigned_technician_id IS NULL
        ORDER BY ir.created_at ASC
        OFFSET ${offset} ROWS FETCH NEXT ${limit} ROWS ONLY
      `.execute(db).then(r => r.rows),

      sql`
        SELECT COUNT(id) AS total
        FROM dbo.installation_requests
        WHERE status = 'pending' AND assigned_technician_id IS NULL
      `.execute(db).then(r => r.rows[0]),
    ]);

    const total = Number(countRow.total);
    return R.ok(res, { jobs: rows.map(formatJob) }, 'OK', 200,
      { page, limit, total, total_pages: Math.ceil(total / limit) });
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /technician/jobs/my
// This technician's assigned jobs (active + recent)
// ─────────────────────────────────────────────────────────────────────────────
router.get('/jobs/my', async (req, res, next) => {
  try {
    const status = req.query.status || '';   // optional filter
    const page   = Math.max(1, parseInt(req.query.page  || '1'));
    const limit  = Math.max(1, parseInt(req.query.limit || '20'));
    const offset = (page - 1) * limit;

    const [rows, countRow] = await Promise.all([
      sql`
        SELECT
          ir.id, ir.request_number, ir.status,
          ir.house_no, ir.address, ir.city, ir.state, ir.pin_code,
          ir.notes, ir.scheduled_at, ir.completed_at,
          ir.assigned_at, ir.assigned_by, ir.created_at,
          u.name  AS customer_name,
          u.phone AS customer_phone
        FROM dbo.installation_requests ir
        INNER JOIN dbo.users u ON u.id = ir.user_id
        WHERE ir.assigned_technician_id = ${BigInt(req.technician.id)}
          ${status ? sql`AND ir.status = ${status}` : sql``}
        ORDER BY
          CASE ir.status
            WHEN 'in_progress' THEN 1
            WHEN 'assigned'    THEN 2
            WHEN 'completed'   THEN 3
            ELSE 4
          END,
          ir.assigned_at DESC
        OFFSET ${offset} ROWS FETCH NEXT ${limit} ROWS ONLY
      `.execute(db).then(r => r.rows),

      sql`
        SELECT COUNT(id) AS total
        FROM dbo.installation_requests
        WHERE assigned_technician_id = ${BigInt(req.technician.id)}
        ${status ? sql`AND status = ${status}` : sql``}
      `.execute(db).then(r => r.rows[0]),
    ]);

    const total = Number(countRow.total);
    return R.ok(res, { jobs: rows.map(formatJob) }, 'OK', 200,
      { page, limit, total, total_pages: Math.ceil(total / limit) });
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /technician/jobs/:id
// Single job detail
// ─────────────────────────────────────────────────────────────────────────────
router.get('/jobs/:id', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return R.badRequest(res, 'Invalid job ID.');

    const row = await sql`
      SELECT
        ir.id, ir.request_number, ir.status,
        ir.house_no, ir.address, ir.city, ir.state, ir.pin_code,
        ir.notes, ir.scheduled_at, ir.completed_at,
        ir.assigned_at, ir.assigned_by, ir.created_at,
        u.name  AS customer_name,
        u.phone AS customer_phone
      FROM dbo.installation_requests ir
      INNER JOIN dbo.users u ON u.id = ir.user_id
      WHERE ir.id = ${BigInt(id)}
        AND ir.assigned_technician_id = ${BigInt(req.technician.id)}
    `.execute(db).then(r => r.rows[0]);

    if (!row) return R.notFound(res, 'Job not found or not assigned to you.');
    return R.ok(res, { job: formatJob(row) });
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /technician/jobs/:id/assign
// Technician self-assigns an open (unassigned pending) request
// ─────────────────────────────────────────────────────────────────────────────
router.post('/jobs/:id/assign', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return R.badRequest(res, 'Invalid job ID.');

    const request = await db
      .selectFrom('dbo.installation_requests')
      .select(['id', 'status', 'assigned_technician_id', 'user_id', 'request_number'])
      .where('id', '=', BigInt(id))
      .executeTakeFirst();

    if (!request) return R.notFound(res, 'Installation request not found.');
    if (request.status !== 'pending')
      return R.badRequest(res, 'This request is no longer available for assignment.');
    if (request.assigned_technician_id)
      return R.conflict(res, 'This request has already been assigned to another technician.');

    const now = new Date();

    await db.updateTable('dbo.installation_requests')
      .set({
        assigned_technician_id: BigInt(req.technician.id),
        assigned_at:            now,
        assigned_by:            'self',
        status:                 'assigned',
      })
      .where('id', '=', BigInt(id))
      .execute();

    // Audit trail
    await db.insertInto('dbo.technician_assignments').values({
      installation_id:  BigInt(id),
      technician_id:    BigInt(req.technician.id),
      assigned_by_type: 'technician',
      assigned_by_id:   BigInt(req.technician.id),
    }).execute();

    // Increment technician load counter
    await db.updateTable('dbo.technicians')
      .set({ current_load: sql`current_load + 1` })
      .where('id', '=', BigInt(req.technician.id))
      .execute();

    // Notify the customer
    await notifyUser(db, Number(request.user_id), {
      type:  'installation',
      title: 'Technician Assigned 🔧',
      body:  `A technician has been assigned to your installation request ${request.request_number}. They will contact you shortly.`,
      data:  { request_number: request.request_number },
    });

    logger.info(`[Tech] Self-assign: tech=${req.technician.id} → request=${id}`);
    return R.ok(res, null, 'Job assigned to you successfully.');
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /technician/jobs/:id/status
// Update job status: assigned → in_progress → completed
// ─────────────────────────────────────────────────────────────────────────────
router.patch('/jobs/:id/status', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return R.badRequest(res, 'Invalid job ID.');

    const { status, notes } = req.body;
    const ALLOWED = ['in_progress', 'completed'];
    if (!ALLOWED.includes(status))
      return R.badRequest(res, `Status must be one of: ${ALLOWED.join(', ')}`);

    const request = await db
      .selectFrom('dbo.installation_requests')
      .select(['id', 'status', 'assigned_technician_id', 'user_id', 'request_number'])
      .where('id', '=', BigInt(id))
      .where('assigned_technician_id', '=', BigInt(req.technician.id))
      .executeTakeFirst();

    if (!request) return R.notFound(res, 'Job not found or not assigned to you.');

    // Enforce valid transitions
    const TRANSITIONS = { assigned: 'in_progress', in_progress: 'completed' };
    if (TRANSITIONS[request.status] !== status)
      return R.badRequest(res, `Cannot move from '${request.status}' to '${status}'.`);

    const updates = { status };
    if (notes?.trim()) updates.notes = notes.trim();
    if (status === 'completed') updates.completed_at = new Date();

    await db.updateTable('dbo.installation_requests')
      .set(updates)
      .where('id', '=', BigInt(id))
      .execute();

    // Decrement load when completed
    if (status === 'completed') {
      await db.updateTable('dbo.technicians')
        .set({ current_load: sql`CASE WHEN current_load > 0 THEN current_load - 1 ELSE 0 END` })
        .where('id', '=', BigInt(req.technician.id))
        .execute();
    }

    // Notify customer
    const notifMap = {
      in_progress: {
        title: 'Technician En Route 🚗',
        body:  `Your technician is on the way for request ${request.request_number}.`,
      },
      completed: {
        title: 'Installation Complete ✅',
        body:  `Your router installation (${request.request_number}) is complete. Welcome to Speedonet!`,
      },
    };

    

    await notifyUser(db, Number(request.user_id), {
      type:  'installation',
      ...notifMap[status],
      data:  { request_number: request.request_number, status },
    });

    if (status === 'completed') {
      await _onInstallationCompleted(Number(request.user_id), request.request_number);
    }

    logger.info(`[Tech] Status update: tech=${req.technician.id} request=${id} → ${status}`);
    return R.ok(res, null, `Job marked as '${status}'.`);
  } catch (err) { next(err); }
});

module.exports = router;