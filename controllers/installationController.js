// controllers/installationController.js
const { db, sql } = require('../config/db');
const R            = require('../utils/response');
const notifyUser   = require('../utils/notifyUser');
const { activatePendingSubscription } = require('../services/planService');

function formatRequest(row) {
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
    created_at:     row.created_at,
    technician: row.technician_name ? {
      name:        row.technician_name,
      phone:       row.technician_phone,
      employee_id: row.technician_employee_id,
    } : null,
  };
}

// POST /installations
async function createRequest(req, res, next) {
  try {
    const { house_no, address, city, state, pin_code, preferred_date, notes } = req.body;
    if (!house_no?.trim() || !address?.trim() || !city?.trim() || !state?.trim() || !pin_code?.trim())
      return R.badRequest(res, 'house_no, address, city, state and pin_code are required.');

    // Block if router already installed
    const completed = await db
      .selectFrom('dbo.installation_requests')
      .select('id')
      .where('user_id', '=', BigInt(req.user.id))
      .where('status',  '=', 'completed')
      .executeTakeFirst();

    if (completed)
      return R.conflict(res,
        'Your router has already been installed. Installations are done only once. ' +
        'If you need assistance, please raise a support ticket.');

    // Block if there is already a pending / in-progress request
    const existing = await db
      .selectFrom('dbo.installation_requests')
      .select('id')
      .where('user_id', '=', BigInt(req.user.id))
      .where('status', 'not in', ['completed', 'cancelled'])
      .executeTakeFirst();

    if (existing)
      return R.conflict(res, 'You already have an active installation request.');

    const row = await db
      .insertInto('dbo.installation_requests')
      .values({
        user_id:        BigInt(req.user.id),
        house_no:       house_no.trim(),
        address:        address.trim(),
        city:           city.trim(),
        state:          state.trim(),
        pin_code:       pin_code.trim(),
        preferred_date: preferred_date || null,
        notes:          notes?.trim()  || null,
      })
      .output(['inserted.id', 'inserted.request_number', 'inserted.status', 'inserted.created_at',
               'inserted.house_no', 'inserted.address', 'inserted.city', 'inserted.state',
               'inserted.pin_code', 'inserted.notes'])
      .executeTakeFirstOrThrow();

    await notifyUser(db, req.user.id, {
      type:  'installation',
      title: 'Installation Request Received 🔧',
      body:  `Your request ${row.request_number} is received. Our team will contact you shortly.`,
      data:  { request_number: row.request_number },
    });

    return R.created(res, { installation: formatRequest(row) },
      'Installation request submitted successfully.');
  } catch (err) { next(err); }
}

// GET /installations/active
async function getActiveRequest(req, res, next) {
  try {
    const row = await db
      .selectFrom('dbo.installation_requests')
      .selectAll()
      .where('user_id', '=', BigInt(req.user.id))
      .where('status', 'not in', ['completed', 'cancelled'])
      .orderBy('created_at', 'desc')
      .top(1)
      .executeTakeFirst();

    return R.ok(res, { installation: row ? formatRequest(row) : null });
  } catch (err) { next(err); }
}

// GET /installations/:id
async function getRequest(req, res, next) {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return R.badRequest(res, 'Invalid installation ID.');

    const row = await db
      .selectFrom('dbo.installation_requests')
      .selectAll()
      .where('id',      '=', BigInt(id))
      .where('user_id', '=', BigInt(req.user.id))
      .executeTakeFirst();

    if (!row) return R.notFound(res, 'Installation request not found.');
    return R.ok(res, { installation: formatRequest(row) });
  } catch (err) { next(err); }
}

/**
 * GET /installations/status
 * Returns a combined view: the latest installation request + any pending
 * subscription that is waiting for it. Used by the Flutter home screen card.
 */
async function getInstallationStatus(req, res, next) {
  try {
    const userId = req.user.id;

    // Most recent installation request of any status
    const installation = await db
      .selectFrom('dbo.installation_requests')
      .selectAll()
      .where('user_id', '=', BigInt(userId))
      .orderBy('created_at', 'desc')
      .top(1)
      .executeTakeFirst();

    // Any subscription waiting for installation
    const pendingPlan = await db
      .selectFrom('dbo.user_subscriptions as s')
      .innerJoin('dbo.broadband_plans as p', 'p.id', 's.plan_id')
      .select([
        's.id as subscription_id',
        's.status as subscription_status',
        'p.name as plan_name',
        'p.speed_mbps',
        'p.validity_days',
      ])
      .where('s.user_id', '=', BigInt(userId))
      .where('s.status',  '=', 'pending_installation')
      .top(1)
      .executeTakeFirst();

    return R.ok(res, {
      installation:  installation ? formatRequest(installation) : null,
      pending_plan:  pendingPlan  ?? null,
    });
  } catch (err) { next(err); }
}

/**
 * Shared helper — called by admin route and technician route when they mark
 * an installation as "completed". Activates any pending_installation plan
 * for the user and fires notifications.
 */
async function _onInstallationCompleted(userId, requestNumber) {
  const activated = await activatePendingSubscription(db, userId);
  if (!activated) return;

  await notifyUser(db, userId, {
    type:  'plan_activated',
    title: 'Plan Activated 🎉',
    body:  `Your ${activated.plan_name} plan is now active until ${activated.expiresAt.toDateString()}. Welcome to Speedonet!`,
    data:  { plan_name: activated.plan_name, request_number: requestNumber },
  });
}

module.exports = {
  createRequest,
  getActiveRequest,
  getRequest,
  getInstallationStatus,
  _onInstallationCompleted,  
};