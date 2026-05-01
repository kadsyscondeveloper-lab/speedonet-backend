// controllers/rentController.js

const rentService = require('../services/rentService');
const R           = require('../utils/response');

// GET /api/v1/rent/status
async function getStatus(req, res, next) {
  try {
    const status = await rentService.getRentStatus(req.user.id);
    return R.ok(res, status);
  } catch (err) { next(err); }
}

// POST /api/v1/rent/collect
async function collect(req, res, next) {
  try {
    const result = await rentService.collectRent(req.user.id);
    return R.ok(
      res,
      result,
      `₹${result.amount.toFixed(2)} collected and added to your wallet!`
    );
  } catch (err) {
    if (err.statusCode) return R.error(res, err.message, err.statusCode);
    next(err);
  }
}

module.exports = { getStatus, collect };