/**
 * controllers/ticketJobController.js
 *
 * Handles all support-job lifecycle actions:
 *
 *  User-facing
 *    getUserJobStatus   — GET  /tickets/:id/job-status
 *
 *  Technician-facing
 *    getOpenSupportJobs — GET  /technician/support-jobs/open
 *    getMySupportJobs   — GET  /technician/support-jobs/mine
 *    grabSupportJob     — POST /technician/support-jobs/:ticketId/grab
 *    resolveSupportJob  — PATCH /technician/support-jobs/:ticketId/resolve
 *
 *  Admin-facing
 *    adminPublishJob    — PATCH /admin/tickets/:id/publish-job
 *    adminUnpublishJob  — PATCH /admin/tickets/:id/unpublish-job
 */

const { db, sql } = require('../config/db');
const R           = require('../utils/response');
const notifyUser  = require('../utils/notifyUser');
const logger      = require('../utils/logger');

// ─────────────────────────────────────────────────────────────────────────────
// USER: GET /api/v1/tickets/:id/job-status
//
// Returns job status + technician info + last known location snapshot.
// Flutter's TicketJobService.getJobStatus() calls this.
//
// Response shape (mirrors TicketJobStatus.fromJson):
// {
//   data: {
//     requires_technician: bool,
//     tech_job_status:     'open' | 'assigned' | 'completed' | null,
//     job_opened_at:       ISO string | null,
//     job_assigned_at:     ISO string | null,
//     job_completed_at:    ISO string | null,
//     technician: { id, name, phone } | null,
//     location:   { lat, lng, updated_at } | null,
//   }
// }
// ─────────────────────────────────────────────────────────────────────────────
async function getUserJobStatus(req, res, next) {
  try {
    const ticketId = parseInt(req.params.id);
    const userId   = req.user.id;

    const ticket = await db
      .selectFrom('dbo.help_tickets as t')
      .leftJoin('dbo.technicians as tech', 'tech.id', 't.assigned_technician_id')
      .select([
        't.id',
        't.requires_technician',
        't.tech_job_status',
        't.job_opened_at',
        't.job_assigned_at',
        't.job_completed_at',
        't.assigned_technician_id',
        'tech.id as tech_id',
        'tech.name as tech_name',
        'tech.phone as tech_phone',
      ])
      .where('t.id',      '=', BigInt(ticketId))
      .where('t.user_id', '=', BigInt(userId))
      .executeTakeFirst();

    if (!ticket) return R.notFound(res, 'Ticket not found.');

    // ── Fetch user's primary address ─────────────────────────────────────────
    const address = await db
      .selectFrom('dbo.user_addresses')
      .select(['house_no', 'address', 'city', 'state', 'pin_code'])
      .where('user_id',    '=', BigInt(userId))
      .where('is_primary', '=', true)
      .executeTakeFirst();

    // ── Fetch last known live location if a technician is assigned ───────────
    let location = null;
    if (ticket.assigned_technician_id) {
      const loc = await db
        .selectFrom('dbo.technician_live_locations')
        .select(['lat', 'lng', 'updated_at'])
        .where('technician_id', '=', ticket.assigned_technician_id)
        .where('ticket_id',     '=', BigInt(ticketId))
        .executeTakeFirst();

      if (loc) {
        location = {
          lat:        parseFloat(loc.lat),
          lng:        parseFloat(loc.lng),
          updated_at: loc.updated_at,
        };
      }
    }

    return R.ok(res, {
      requires_technician: ticket.requires_technician ?? false,
      tech_job_status:     ticket.tech_job_status ?? null,
      job_opened_at:       ticket.job_opened_at   ?? null,
      job_assigned_at:     ticket.job_assigned_at  ?? null,
      job_completed_at:    ticket.job_completed_at ?? null,
      technician: ticket.tech_id
        ? {
            id:    Number(ticket.tech_id),
            name:  ticket.tech_name,
            phone: ticket.tech_phone,
          }
        : null,
      location,
      address: address
        ? {
            house_no: address.house_no ?? null,
            address:  address.address  ?? null,
            city:     address.city     ?? null,
            state:    address.state    ?? null,
            pin_code: address.pin_code ?? null,
          }
        : null,
    });
  } catch (err) { next(err); }
}

// ─────────────────────────────────────────────────────────────────────────────
// ADMIN: PATCH /admin/tickets/:id/publish-job
//
// Marks a ticket as requiring a technician and opens the job board listing.
// Sets: requires_technician=true, tech_job_status='open', job_opened_at=now
// ─────────────────────────────────────────────────────────────────────────────
async function adminPublishJob(req, res, next) {
  try {
    const ticketId = parseInt(req.params.id);

    const ticket = await db
      .selectFrom('dbo.help_tickets')
      .select(['id', 'tech_job_status', 'requires_technician', 'user_id'])
      .where('id', '=', BigInt(ticketId))
      .executeTakeFirst();

    if (!ticket) return R.notFound(res, 'Ticket not found.');

    if (ticket.tech_job_status === 'assigned') {
      return R.badRequest(res, 'Job is already assigned to a technician.');
    }
    if (ticket.tech_job_status === 'completed') {
      return R.badRequest(res, 'Job is already completed.');
    }

    await db
      .updateTable('dbo.help_tickets')
      .set({
        requires_technician: true,
        tech_job_status:     'open',
        job_opened_at:       new Date(),
        updated_at:          sql`SYSUTCDATETIME()`,
      })
      .where('id', '=', BigInt(ticketId))
      .execute();

    // Notify the user that a technician is being dispatched
    await notifyUser(db, Number(ticket.user_id), {
      type:  'support_ticket',
      title: 'Technician Being Dispatched 🔧',
      body:  'A technician has been assigned to your ticket and will contact you soon.',
      data:  { ticket_id: String(ticketId) },
    });

    logger.info(`[Admin] Ticket ${ticketId} published as support job by admin ${req.admin.id}`);
    return R.ok(res, null, 'Support job published. Technicians can now see and grab this job.');
  } catch (err) { next(err); }
}

// ─────────────────────────────────────────────────────────────────────────────
// ADMIN: PATCH /admin/tickets/:id/unpublish-job
//
// Retracts the job listing. Only works while still 'open' (not yet grabbed).
// ─────────────────────────────────────────────────────────────────────────────
async function adminUnpublishJob(req, res, next) {
  try {
    const ticketId = parseInt(req.params.id);

    const ticket = await db
      .selectFrom('dbo.help_tickets')
      .select(['id', 'tech_job_status'])
      .where('id', '=', BigInt(ticketId))
      .executeTakeFirst();

    if (!ticket) return R.notFound(res, 'Ticket not found.');

    if (ticket.tech_job_status === 'assigned') {
      return R.badRequest(res, 'Cannot unpublish — a technician has already grabbed this job. Use the ticket status update instead.');
    }
    if (ticket.tech_job_status === 'completed') {
      return R.badRequest(res, 'Cannot unpublish a completed job.');
    }

    await db
      .updateTable('dbo.help_tickets')
      .set({
        requires_technician:    false,
        tech_job_status:        null,
        job_opened_at:          null,
        assigned_technician_id: null,
        updated_at:             sql`SYSUTCDATETIME()`,
      })
      .where('id', '=', BigInt(ticketId))
      .execute();

    logger.info(`[Admin] Ticket ${ticketId} unpublished by admin ${req.admin.id}`);
    return R.ok(res, null, 'Support job unpublished.');
  } catch (err) { next(err); }
}

// ─────────────────────────────────────────────────────────────────────────────
// TECHNICIAN: GET /technician/support-jobs/open
//
// Lists all tickets with tech_job_status='open' (no technician yet).
// ─────────────────────────────────────────────────────────────────────────────
async function getOpenSupportJobs(req, res, next) {
  try {
    const page   = Math.max(1, parseInt(req.query.page  || '1'));
    const limit  = Math.max(1, parseInt(req.query.limit || '20'));
    const offset = (page - 1) * limit;

    const [rows, countRow] = await Promise.all([
      sql`
        SELECT
          t.id, t.ticket_number, t.category, t.subject,
          t.priority, t.job_opened_at, t.created_at,
          u.name  AS customer_name,
          u.phone AS customer_phone,
          a.house_no, a.address, a.city, a.state, a.pin_code
        FROM dbo.help_tickets t
        INNER JOIN dbo.users u ON u.id = t.user_id
        LEFT JOIN dbo.user_addresses a
          ON a.user_id = t.user_id AND a.is_primary = 1
        WHERE t.tech_job_status = 'open'
          AND t.assigned_technician_id IS NULL
        ORDER BY t.job_opened_at ASC
        OFFSET ${offset} ROWS FETCH NEXT ${limit} ROWS ONLY
      `.execute(db).then(r => r.rows),

      sql`
        SELECT COUNT(id) AS total
        FROM dbo.help_tickets
        WHERE tech_job_status = 'open'
          AND assigned_technician_id IS NULL
      `.execute(db).then(r => r.rows[0]),
    ]);

    const total = Number(countRow.total);
    return R.ok(res, { jobs: rows.map(formatSupportJob) }, 'OK', 200,
      { page, limit, total, total_pages: Math.ceil(total / limit) });
  } catch (err) { next(err); }
}

// ─────────────────────────────────────────────────────────────────────────────
// TECHNICIAN: GET /technician/support-jobs/mine
//
// Lists this technician's own support jobs.
// Optional ?status=assigned|completed
// ─────────────────────────────────────────────────────────────────────────────
async function getMySupportJobs(req, res, next) {
  try {
    const techId = req.technician.id;
    const status = req.query.status || '';   // 'assigned' | 'completed' | ''

    const [rows] = await Promise.all([
      sql`
        SELECT
          t.id, t.ticket_number, t.category, t.subject,
          t.priority, t.tech_job_status,
          t.job_opened_at, t.job_assigned_at, t.job_completed_at,
          u.name  AS customer_name,
          u.phone AS customer_phone,
          a.house_no, a.address, a.city, a.state, a.pin_code
        FROM dbo.help_tickets t
        INNER JOIN dbo.users u ON u.id = t.user_id
        LEFT JOIN dbo.user_addresses a
          ON a.user_id = t.user_id AND a.is_primary = 1
        WHERE t.assigned_technician_id = ${BigInt(techId)}
          ${status ? sql`AND t.tech_job_status = ${status}` : sql``}
        ORDER BY
          CASE t.tech_job_status
            WHEN 'assigned'  THEN 1
            WHEN 'completed' THEN 2
            ELSE 3
          END,
          t.job_assigned_at DESC
      `.execute(db).then(r => r.rows),
    ]);

    return R.ok(res, { jobs: rows.map(formatSupportJob) });
  } catch (err) { next(err); }
}

// ─────────────────────────────────────────────────────────────────────────────
// TECHNICIAN: POST /technician/support-jobs/:ticketId/grab
//
// Technician self-assigns an open support job.
// ─────────────────────────────────────────────────────────────────────────────
async function grabSupportJob(req, res, next) {
  try {
    const ticketId = parseInt(req.params.ticketId);
    const techId   = req.technician.id;

    const ticket = await db
      .selectFrom('dbo.help_tickets')
      .select(['id', 'tech_job_status', 'assigned_technician_id', 'user_id', 'ticket_number'])
      .where('id', '=', BigInt(ticketId))
      .executeTakeFirst();

    if (!ticket) return R.notFound(res, 'Ticket not found.');

    if (ticket.tech_job_status !== 'open') {
      return R.badRequest(res, `Job is not open for grabbing (current status: ${ticket.tech_job_status ?? 'none'}).`);
    }
    if (ticket.assigned_technician_id) {
      return R.conflict(res, 'Another technician has already grabbed this job.');
    }

    const now = new Date();

    await db
      .updateTable('dbo.help_tickets')
      .set({
        assigned_technician_id: BigInt(techId),
        tech_job_status:        'assigned',
        job_assigned_at:        now,
        updated_at:             sql`SYSUTCDATETIME()`,
      })
      .where('id', '=', BigInt(ticketId))
      // Optimistic lock: only grab if still open
      .where('tech_job_status',        '=', 'open')
      .where('assigned_technician_id', 'is', null)
      .execute();

    // Re-check it was actually grabbed (race condition guard)
    const updated = await db
      .selectFrom('dbo.help_tickets')
      .select(['assigned_technician_id', 'tech_job_status'])
      .where('id', '=', BigInt(ticketId))
      .executeTakeFirst();

    if (Number(updated?.assigned_technician_id) !== techId) {
      return R.conflict(res, 'Another technician grabbed this job just now. Please try another.');
    }

    // Notify user
    await notifyUser(db, Number(ticket.user_id), {
      type:  'support_ticket',
      title: 'Technician On The Way 🚗',
      body:  `A technician has been assigned to your ticket ${ticket.ticket_number} and is on the way.`,
      data:  { ticket_id: String(ticketId), tech_job_status: 'assigned' },
    });

    logger.info(`[Tech] Grabbed support job: tech=${techId} ticket=${ticketId}`);
    return R.ok(res, null, 'Job grabbed successfully. The customer has been notified.');
  } catch (err) { next(err); }
}

// ─────────────────────────────────────────────────────────────────────────────
// TECHNICIAN: PATCH /technician/support-jobs/:ticketId/resolve
//
// Marks the job as completed. Clears live location.
// ─────────────────────────────────────────────────────────────────────────────
async function resolveSupportJob(req, res, next) {
  try {
    const ticketId      = parseInt(req.params.ticketId);
    const techId        = req.technician.id;
    const resolutionNote = req.body.resolution_note?.trim() || null;

    const ticket = await db
      .selectFrom('dbo.help_tickets')
      .select(['id', 'tech_job_status', 'assigned_technician_id', 'user_id', 'ticket_number'])
      .where('id', '=', BigInt(ticketId))
      .where('assigned_technician_id', '=', BigInt(techId))
      .executeTakeFirst();

    if (!ticket) return R.notFound(res, 'Job not found or not assigned to you.');

    if (ticket.tech_job_status !== 'assigned') {
      return R.badRequest(res, `Cannot resolve — job status is '${ticket.tech_job_status}'.`);
    }

    const now = new Date();

    await db
      .updateTable('dbo.help_tickets')
      .set({
        tech_job_status:  'completed',
        job_completed_at: now,
        updated_at:       sql`SYSUTCDATETIME()`,
        // Optionally store resolution note in the status field or a separate column
        // If your schema has a resolution_note column, add it here:
        // resolution_note: resolutionNote,
      })
      .where('id', '=', BigInt(ticketId))
      .execute();

    // Add a system reply with the resolution note if provided
    if (resolutionNote) {
      await db.insertInto('dbo.ticket_replies').values({
        ticket_id:   BigInt(ticketId),
        sender_id:   BigInt(techId),
        sender_type: 'agent',
        message:     `[Technician Note] ${resolutionNote}`,
      }).execute();
    }

    // Clean up live location
    await db
      .deleteFrom('dbo.technician_live_locations')
      .where('technician_id', '=', BigInt(techId))
      .where('ticket_id',     '=', BigInt(ticketId))
      .execute();

    // Notify user
    await notifyUser(db, Number(ticket.user_id), {
      type:  'support_ticket',
      title: 'Issue Resolved ✅',
      body:  `Your ticket ${ticket.ticket_number} has been resolved by the technician.${resolutionNote ? ' Note: ' + resolutionNote : ''}`,
      data:  { ticket_id: String(ticketId), tech_job_status: 'completed' },
    });

    logger.info(`[Tech] Resolved support job: tech=${techId} ticket=${ticketId}`);
    return R.ok(res, null, 'Job marked as resolved. Customer has been notified.');
  } catch (err) { next(err); }
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared formatter for support job rows
// ─────────────────────────────────────────────────────────────────────────────
function formatSupportJob(row) {
  return {
    id:              Number(row.id),
    ticket_number:   row.ticket_number,
    category:        row.category,
    subject:         row.subject,
    priority:        row.priority,
    tech_job_status: row.tech_job_status ?? null,
    job_opened_at:   row.job_opened_at   ?? null,
    job_assigned_at: row.job_assigned_at  ?? null,
    job_completed_at: row.job_completed_at ?? null,
    created_at:      row.created_at,
    customer: {
      name:  row.customer_name,
      phone: row.customer_phone,
    },
    address: {
      house_no: row.house_no ?? null,
      address:  row.address  ?? null,
      city:     row.city     ?? null,
      state:    row.state    ?? null,
      pin_code: row.pin_code ?? null,
    },
  };
}

module.exports = {
  getUserJobStatus,
  adminPublishJob,
  adminUnpublishJob,
  getOpenSupportJobs,
  getMySupportJobs,
  grabSupportJob,
  resolveSupportJob,
};