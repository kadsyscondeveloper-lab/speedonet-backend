// services/ticketService.js

const { db, sql } = require('../config/db');
const crypto      = require('crypto');
const notifyUser  = require('../utils/notifyUser');

function generateTicketNumber() {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const rand  = crypto.randomBytes(3).toString('hex').toUpperCase();
  return `SPT-${date}-${rand}`;
}

const VALID_CATEGORIES = [
  'Billing', 'Technical Issue', 'Connection Issue', 'Slow Speed',
  'New Connection', 'Installation', 'Plan Change', 'KYC', 'Other',
];

// ── Create ticket ─────────────────────────────────────────────────────────────

async function createTicket(userId, {
  category, subject, description, priority = 'medium', attachmentData = null,
}) {
  const ticketNumber = generateTicketNumber();

  const row = await db
    .insertInto('dbo.help_tickets')
    .values({
      user_id:        BigInt(userId),
      ticket_number:  ticketNumber,
      category,
      subject,
      description,
      priority,
      attachment_url: attachmentData ?? null,
    })
    .output(['inserted.id', 'inserted.ticket_number', 'inserted.status',
             'inserted.priority', 'inserted.created_at'])
    .executeTakeFirstOrThrow();

  // Ticket created notification (DB + Push)
  await notifyUser(db, userId, {
    type:  'support_ticket',
    title: 'Support Ticket Created 🎫',
    body:  `Your ticket ${ticketNumber} has been received. We'll get back to you shortly.`,
    data:  { ticket_number: ticketNumber },
  });

  return row;
}

// ── List tickets ──────────────────────────────────────────────────────────────

async function getUserTickets(userId, { page = 1, limit = 10 } = {}) {
  const offset = (page - 1) * limit;

  const [rows, countRow] = await Promise.all([
    sql`
      SELECT id, ticket_number, category, subject,
             status, priority, created_at, updated_at
      FROM dbo.help_tickets
      WHERE user_id = ${BigInt(userId)}
      ORDER BY created_at DESC
      OFFSET ${offset} ROWS FETCH NEXT ${limit} ROWS ONLY
    `.execute(db).then(r => r.rows),

    db.selectFrom('dbo.help_tickets')
      .select(db.fn.count('id').as('total'))
      .where('user_id', '=', BigInt(userId))
      .executeTakeFirstOrThrow(),
  ]);

  return { tickets: rows, total: Number(countRow.total) };
}

// ── Single ticket with replies ────────────────────────────────────────────────

async function getTicketById(userId, ticketId) {
  const ticket = await db
    .selectFrom('dbo.help_tickets')
    .select(['id', 'ticket_number', 'category', 'subject', 'description',
             'status', 'priority', 'resolved_at', 'created_at', 'updated_at'])
    .where('id',      '=', BigInt(ticketId))
    .where('user_id', '=', BigInt(userId))
    .executeTakeFirst();

  if (!ticket) return null;

  const replies = await db
    .selectFrom('dbo.ticket_replies')
    .select(['id', 'sender_id', 'sender_type', 'message', 'attachment_url', 'created_at'])
    .where('ticket_id', '=', BigInt(ticketId))
    .orderBy('created_at', 'asc')
    .execute();

  return { ...ticket, replies };
}

// ── Chat: get messages ────────────────────────────────────────────────────────

async function getMessages(userId, ticketId, { afterId = null } = {}) {
  const ticket = await db
    .selectFrom('dbo.help_tickets')
    .select(['id', 'status', 'ticket_number', 'subject'])
    .where('id',      '=', BigInt(ticketId))
    .where('user_id', '=', BigInt(userId))
    .executeTakeFirst();

  if (!ticket) return null;

  let query = db
    .selectFrom('dbo.ticket_replies')
    .select(['id', 'sender_id', 'sender_type', 'message', 'attachment_url', 'created_at'])
    .where('ticket_id', '=', BigInt(ticketId))
    .orderBy('created_at', 'asc');

  if (afterId) query = query.where('id', '>', BigInt(afterId));

  const messages = await query.execute();

  return {
    ticket_id:     ticket.id,
    ticket_number: ticket.ticket_number,
    subject:       ticket.subject,
    status:        ticket.status,
    is_active:     !['resolved', 'closed', 'Resolved', 'Closed'].includes(ticket.status),
    messages,
  };
}

// ── Add a user reply ──────────────────────────────────────────────────────────

async function addReply(userId, ticketId, { message, attachmentData = null }) {
  const ticket = await db
    .selectFrom('dbo.help_tickets')
    .select(['id', 'status'])
    .where('id',      '=', BigInt(ticketId))
    .where('user_id', '=', BigInt(userId))
    .executeTakeFirst();

  if (!ticket)
    throw Object.assign(new Error('Ticket not found.'), { statusCode: 404 });

  const closedStatuses = ['closed', 'resolved', 'Closed', 'Resolved'];
  if (closedStatuses.includes(ticket.status))
    throw Object.assign(
      new Error('Cannot reply to a closed or resolved ticket.'),
      { statusCode: 400 }
    );

  const row = await db
    .insertInto('dbo.ticket_replies')
    .values({
      ticket_id:      BigInt(ticketId),
      sender_id:      BigInt(userId),
      sender_type:    'user',
      message,
      attachment_url: attachmentData ?? null,
    })
    .output(['inserted.id', 'inserted.created_at'])
    .executeTakeFirstOrThrow();

  await db
    .updateTable('dbo.help_tickets')
    .set({ updated_at: sql`SYSUTCDATETIME()` })
    .where('id', '=', BigInt(ticketId))
    .execute();

  return row;
}

module.exports = {
  createTicket,
  getUserTickets,
  getTicketById,
  getMessages,
  addReply,
  VALID_CATEGORIES,
};