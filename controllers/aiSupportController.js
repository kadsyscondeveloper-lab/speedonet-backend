// controllers/aiSupportController.js

const aiService = require('../services/aiSupportService');
const R         = require('../utils/response');

// POST /api/v1/ai-support/sessions
async function startSession(req, res, next) {
  try {
    const result = await aiService.startSession(req.user.id);
    return R.created(res, result, 'Session started.');
  } catch (err) { next(err); }
}

// POST /api/v1/ai-support/sessions/:id/message
async function sendMessage(req, res, next) {
  try {
    const sessionId = parseInt(req.params.id);
    if (isNaN(sessionId)) return R.badRequest(res, 'Invalid session ID.');

    const { message } = req.body;
    if (!message?.trim()) return R.badRequest(res, 'message is required.');

    const result = await aiService.processMessage(
      req.user.id, sessionId, message.trim()
    );
    return R.ok(res, result);
  } catch (err) {
    if (err.statusCode) return R.error(res, err.message, err.statusCode);
    next(err);
  }
}

// GET /api/v1/ai-support/sessions/:id
async function getSession(req, res, next) {
  try {
    const sessionId = parseInt(req.params.id);
    if (isNaN(sessionId)) return R.badRequest(res, 'Invalid session ID.');

    const result = await aiService.getSession(req.user.id, sessionId);
    if (!result) return R.notFound(res, 'Session not found.');
    return R.ok(res, result);
  } catch (err) { next(err); }
}

// GET /api/v1/ai-support/sessions
async function getSessions(req, res, next) {
  try {
    const sessions = await aiService.getUserSessions(req.user.id);
    return R.ok(res, { sessions });
  } catch (err) { next(err); }
}

module.exports = { startSession, sendMessage, getSession, getSessions };
