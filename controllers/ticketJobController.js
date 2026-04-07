/**
 * controllers/ticketJobController.js
 *
 * Handles the "ticket → technician support job" lifecycle:
 *   Admin   → publishes a ticket as a technician job (makes it grabbable)
 *   Tech    → browses open jobs, self-assigns, resolves
 *   User    → checks job status + latest technician location
 */

const { db, sql } = require('../config/db');
const R            = require('../utils/response');
const notifyUser   = require('../utils/notifyUser');
const logger       = require('../utils/logger');

// ─────────────────────────────────────────────────────────────────────────────
// ADMIN  —  PATCH /admin/tickets/:id/publish-job
// Makes a support ticket visible in the technician's job list.
// ─────────────────────────────────────────────────────────────────────────────
async function adminPublishJob(req, res, next) {
  try {
    const ticketId = parseInt(req.params.id);
    if (isNaN(ticketId)) return R.badRequest(res, 'Invalid ticket ID.');

    // Fetch the ticket
    const ticket = await db
      .selectFrom('dbo.help_tickets')
      .select(['id', 'user_id', 'status', 'subject', 'tech_job_status'])
      .where('id', '=', ticketId)
      .executeTakeFirst();

    if (!ticket) return R.notFound(res, 'Ticket not found.');

    if (ticket.tech_job_status === 'open' || ticket.tech_job_status === 'assigned') {
      return R.conflict(res, 'This ticket is already published as a technician job.');
    }

    if (ticket.tech_job_status === 'completed') {
      return R.conflict(res, 'This job is already completed.');
    }

    await db
      .updateTable('dbo.help_tickets')
      .set({
        requires_technician: true,
        tech_job_status:     'open',
        job_opened_at:       new Date(),
      })
      .where('id', '=', ticketId)
      .execute();

    // Notify the user their ticket now has a technician dispatched
    try {
      await notifyUser(ticket.user_id, {
        title: '🔧 Technician Dispatched',
        body:  `Your ticket "${ticket.subject}" has been queued for a technician visit.`,
        data:  { type: 'ticket_job_open', ticket_id: String(ticketId) },
      });
    } catch (notifyErr) {
      logger.warn('FCM notify failed for ticket job publish:', notifyErr.message);
    }

    return R.ok(res, { ticket_id: ticketId, tech_job_status: 'open' }, 'Ticket published as technician job.');
  } catch (err) { next(err); }
}

// ─────────────────────────────────────────────────────────────────────────────
// ADMIN  —  PATCH /admin/tickets/:id/unpublish-job
// Retracts the job (e.g. admin resolves it themselves)
// ─────────────────────────────────────────────────────────────────────────────
async function adminUnpublishJob(req, res, next) {
  try {
    const ticketId = parseInt(req.params.id);
    if (isNaN(ticketId)) return R.badRequest(res, 'Invalid ticket ID.');

    const ticket = await db
      .selectFrom('dbo.help_tickets')
      .select(['id', 'tech_job_status'])
      .where('id', '=', ticketId)
      .executeTakeFirst();

    if (!ticket) return R.notFound(res, 'Ticket not found.');
    if (ticket.tech_job_status !== 'open') {
      return R.conflict(res, 'Only open (unassigned) jobs can be unpublished.');
    }

    await db
      .updateTable('dbo.help_tickets')
      .set({
        requires_technician:    false,
        tech_job_status:        null,
        job_opened_at:          null,
      })
      .where('id', '=', ticketId)
      .execute();

    return R.ok(res, null, 'Technician job retracted.');
  } catch (err) { next(err); }
}

// ─────────────────────────────────────────────────────────────────────────────
// TECHNICIAN  —  GET /technician/support-jobs/open
// List all support tickets awaiting a technician (status = 'open')
// ─────────────────────────────────────────────────────────────────────────────
async function getOpenSupportJobs(req, res, next) {
  try {
    const page   = Math.max(1, parseInt(req.query.page  || '1'));
    const limit  = Math.min(50, Math.max(1, parseInt(req.query.limit || '20')));
    const offset = (page - 1) * limit;

    const [rows, countRow] = await Promise.all([
      sql`
        SELECT
          t.id, t.subject, t.category, t.priority, t.status,
          t.job_opened_at, t.created_at,
          u.name  AS customer_name,
          u.phone AS customer_phone,
          u.id    AS customer_id
        FROM dbo.help_tickets t
        INNER JOIN dbo.users u ON u.id = t.user_id
        WHERE t.tech_job_status = 'open'
        ORDER BY
          CASE t.priority WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
          t.job_opened_at ASC
        OFFSET ${offset} ROWS FETCH NEXT ${limit} ROWS ONLY
      `.execute(db).then(r => r.rows),

      sql`
        SELECT COUNT(id) AS total
        FROM dbo.help_tickets
        WHERE tech_job_status = 'open'
      `.execute(db).then(r => r.rows[0]),
    ]);

    return R.ok(res, {
      jobs:  rows.map(formatSupportJob),
      total: Number(countRow.total),
      page,
      limit,
    });
  } catch (err) { next(err); }
}

// ─────────────────────────────────────────────────────────────────────────────
// TECHNICIAN  —  POST /technician/support-jobs/:ticketId/grab
// Self-assign an open support job
// ─────────────────────────────────────────────────────────────────────────────
async function grabSupportJob(req, res, next) {
  try {
    const ticketId     = parseInt(req.params.ticketId);
    const technicianId = req.technician.id;

    if (isNaN(ticketId)) return R.badRequest(res, 'Invalid ticket ID.');

    // Optimistic lock — only grab if still 'open'
    const result = await sql`
      UPDATE dbo.help_tickets
      SET
        tech_job_status       = 'assigned',
        assigned_technician_id = ${technicianId},
        job_assigned_at        = GETUTCDATE()
      OUTPUT
        inserted.id,
        inserted.user_id,
        inserted.subject,
        inserted.tech_job_status
      WHERE id = ${ticketId}
        AND tech_job_status = 'open'
    `.execute(db);

    if (!result.rows.length) {
      // Either doesn't exist or was grabbed by another technician
      const ticket = await db
        .selectFrom('dbo.help_tickets')
        .select(['tech_job_status'])
        .where('id', '=', ticketId)
        .executeTakeFirst();

      if (!ticket) return R.notFound(res, 'Ticket not found.');
      return R.conflict(res, 'This job was already grabbed by another technician.');
    }

    const grabbed = result.rows[0];

    // Notify the user their technician is on the way
    try {
      await notifyUser(grabbed.user_id, {
        title: '🚗 Technician On the Way',
        body:  `A technician has accepted your ticket "${grabbed.subject}" and is heading to you.`,
        data:  { type: 'tech_job_assigned', ticket_id: String(ticketId) },
      });
    } catch (notifyErr) {
      logger.warn('FCM notify failed on job grab:', notifyErr.message);
    }

    return R.ok(res, { ticket_id: ticketId, tech_job_status: 'assigned' }, 'Job grabbed successfully.');
  } catch (err) { next(err); }
}

// ─────────────────────────────────────────────────────────────────────────────
// TECHNICIAN  —  GET /technician/support-jobs/mine
// Technician's own assigned support jobs
// ─────────────────────────────────────────────────────────────────────────────
async function getMySupportJobs(req, res, next) {
  try {
    const technicianId = req.technician.id;
    const { status = 'assigned' } = req.query; // 'assigned' | 'completed'

    const validStatuses = ['assigned', 'completed'];
    if (!validStatuses.includes(status)) {
      return R.badRequest(res, `status must be one of: ${validStatuses.join(', ')}`);
    }

    const rows = await sql`
      SELECT
        t.id, t.subject, t.category, t.priority, t.status,
        t.tech_job_status, t.job_assigned_at, t.job_completed_at, t.created_at,
        u.name  AS customer_name,
        u.phone AS customer_phone
      FROM dbo.help_tickets t
      INNER JOIN dbo.users u ON u.id = t.user_id
      WHERE t.assigned_technician_id = ${technicianId}
        AND t.tech_job_status = ${status}
      ORDER BY t.job_assigned_at DESC
    `.execute(db).then(r => r.rows);

    return R.ok(res, { jobs: rows.map(formatSupportJob) });
  } catch (err) { next(err); }
}

// ─────────────────────────────────────────────────────────────────────────────
// TECHNICIAN  —  PATCH /technician/support-jobs/:ticketId/resolve
// Mark a support job as completed
// ─────────────────────────────────────────────────────────────────────────────
async function resolveSupportJob(req, res, next) {
  try {
    const ticketId     = parseInt(req.params.ticketId);
    const technicianId = req.technician.id;
    const { resolution_note } = req.body;

    if (isNaN(ticketId)) return R.badRequest(res, 'Invalid ticket ID.');

    const result = await sql`
      UPDATE dbo.help_tickets
      SET
        tech_job_status  = 'completed',
        job_completed_at = GETUTCDATE(),
        status           = 'resolved'
      OUTPUT
        inserted.id,
        inserted.user_id,
        inserted.subject
      WHERE id                    = ${ticketId}
        AND assigned_technician_id = ${technicianId}
        AND tech_job_status        = 'assigned'
    `.execute(db);

    if (!result.rows.length) {
      return R.notFound(res, 'No active job found for this ticket assigned to you.');
    }

    const resolved = result.rows[0];

    // Clear technician's live location for this ticket
    await sql`
      UPDATE dbo.technician_live_locations
      SET ticket_id = NULL
      WHERE technician_id = ${technicianId}
        AND ticket_id     = ${ticketId}
    `.execute(db);

    // Notify user
    try {
      await notifyUser(resolved.user_id, {
        title: '✅ Ticket Resolved',
        body:  `Your ticket "${resolved.subject}" has been resolved by the technician.`,
        data:  { type: 'tech_job_completed', ticket_id: String(ticketId) },
      });
    } catch (notifyErr) {
      logger.warn('FCM notify failed on job resolve:', notifyErr.message);
    }

    return R.ok(res, { ticket_id: ticketId, tech_job_status: 'completed' }, 'Job marked as resolved.');
  } catch (err) { next(err); }
}

// ─────────────────────────────────────────────────────────────────────────────
// USER  —  GET /tickets/:id/job-status
// User checks their ticket's technician job + last known location
// ─────────────────────────────────────────────────────────────────────────────
async function getUserJobStatus(req, res, next) {
  try {
    const ticketId = parseInt(req.params.id);
    const userId   = req.user.id;

    if (isNaN(ticketId)) return R.badRequest(res, 'Invalid ticket ID.');

    const row = await sql`
      SELECT
        t.id              AS ticket_id,
        t.subject,
        t.tech_job_status,
        t.job_opened_at,
        t.job_assigned_at,
        t.job_completed_at,
        tech.id           AS technician_id,
        tech.name         AS technician_name,
        tech.phone        AS technician_phone,
        loc.lat,
        loc.lng,
        loc.updated_at    AS location_updated_at
      FROM dbo.help_tickets t
      LEFT JOIN dbo.technicians tech ON tech.id = t.assigned_technician_id
      LEFT JOIN dbo.technician_live_locations loc ON loc.technician_id = t.assigned_technician_id
        AND loc.ticket_id = t.id
      WHERE t.id      = ${ticketId}
        AND t.user_id = ${userId}
    `.execute(db).then(r => r.rows[0]);

    if (!row) return R.notFound(res, 'Ticket not found.');

    if (!row.tech_job_status) {
      return R.ok(res, { requires_technician: false });
    }

    return R.ok(res, {
      requires_technician: true,
      tech_job_status:     row.tech_job_status,
      job_opened_at:       row.job_opened_at,
      job_assigned_at:     row.job_assigned_at,
      job_completed_at:    row.job_completed_at,
      technician: row.technician_id ? {
        id:    Number(row.technician_id),
        name:  row.technician_name,
        phone: row.technician_phone,
      } : null,
      // Latest location snapshot — frontend also gets live updates via Socket.io
      location: (row.lat != null && row.lng != null) ? {
        lat:        parseFloat(row.lat),
        lng:        parseFloat(row.lng),
        updated_at: row.location_updated_at,
      } : null,
    });
  } catch (err) { next(err); }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────
function formatSupportJob(row) {
  return {
    ticket_id:       Number(row.id),
    subject:         row.subject,
    category:        row.category,
    priority:        row.priority,
    status:          row.status,
    tech_job_status: row.tech_job_status,
    job_opened_at:   row.job_opened_at,
    job_assigned_at: row.job_assigned_at ?? null,
    job_completed_at:row.job_completed_at ?? null,
    created_at:      row.created_at,
    customer: row.customer_name ? {
      id:    row.customer_id ? Number(row.customer_id) : undefined,
      name:  row.customer_name,
      phone: row.customer_phone,
    } : undefined,
  };
}

module.exports = {
  adminPublishJob,
  adminUnpublishJob,
  getOpenSupportJobs,
  grabSupportJob,
  getMySupportJobs,
  resolveSupportJob,
  getUserJobStatus,
};