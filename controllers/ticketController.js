/**
 * controllers/ticketController.js
 */

const ticketService = require('../services/ticketService');
const R             = require('../utils/response');

// POST /api/v1/tickets
async function createTicket(req, res, next) {
  try {
    const { category, subject, description, priority, attachment_data } = req.body;

    const ticket = await ticketService.createTicket(req.user.id, {
      category,
      subject,
      description,
      priority,
      attachmentData: attachment_data || null,
    });

    return R.created(res, { ticket }, `Ticket ${ticket.ticket_number} created successfully.`);
  } catch (err) { next(err); }
}

// GET /api/v1/tickets
async function getTickets(req, res, next) {
  try {
    const page  = parseInt(req.query.page  || '1');
    const limit = parseInt(req.query.limit || '10');
    const data  = await ticketService.getUserTickets(req.user.id, { page, limit });

    return R.ok(res, data, 'OK', 200, {
      page, limit,
      total:       data.total,
      total_pages: Math.ceil(data.total / limit),
    });
  } catch (err) { next(err); }
}

// GET /api/v1/tickets/:id
async function getTicket(req, res, next) {
  try {
    const ticketId = parseInt(req.params.id);
    if (isNaN(ticketId)) return R.badRequest(res, 'Invalid ticket ID.');

    const ticket = await ticketService.getTicketById(req.user.id, ticketId);
    if (!ticket) return R.notFound(res, 'Ticket not found.');

    return R.ok(res, { ticket });
  } catch (err) { next(err); }
}

// POST /api/v1/tickets/:id/replies
async function addReply(req, res, next) {
  try {
    const ticketId = parseInt(req.params.id);
    if (isNaN(ticketId)) return R.badRequest(res, 'Invalid ticket ID.');

    const { message, attachment_data, attachment_mime } = req.body;

    const reply = await ticketService.addReply(req.user.id, ticketId, {
      message,
      attachmentData: attachment_data || null,
      attachmentMime: attachment_mime || null,
    });

    return R.created(res, { reply }, 'Reply added.');
  } catch (err) {
    if (err.statusCode) return R.error(res, err.message, err.statusCode);
    next(err);
  }
}

// GET /api/v1/tickets/:id/messages?after=<reply_id>
async function getMessages(req, res, next) {
  try {
    const ticketId = parseInt(req.params.id);
    if (isNaN(ticketId)) return R.badRequest(res, 'Invalid ticket ID.');

    const afterId = req.query.after ? parseInt(req.query.after) : null;

    const result = await ticketService.getMessages(req.user.id, ticketId, { afterId });
    if (!result) return R.notFound(res, 'Ticket not found.');

    return R.ok(res, result);
  } catch (err) { next(err); }
}

module.exports = { createTicket, getTickets, getTicket, addReply, getMessages };