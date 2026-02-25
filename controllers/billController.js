// controllers/billController.js
const billService = require('../services/billService');
const R           = require('../utils/response');

// GET /api/v1/user/bills
async function getBills(req, res, next) {
  try {
    const page  = parseInt(req.query.page  || '1');
    const limit = parseInt(req.query.limit || '20');
    const data  = await billService.getUserBills(req.user.id, { page, limit });

    return R.ok(res, data, 'OK', 200, {
      page,
      limit,
      total:       data.total,
      total_pages: Math.ceil(data.total / limit),
    });
  } catch (err) { next(err); }
}

// GET /api/v1/user/bills/:id
async function getBill(req, res, next) {
  try {
    const billId = parseInt(req.params.id);
    if (isNaN(billId)) return R.badRequest(res, 'Invalid bill ID.');

    const bill = await billService.getBillById(req.user.id, billId);
    if (!bill) return R.notFound(res, 'Bill not found.');

    return R.ok(res, { bill });
  } catch (err) { next(err); }
}

module.exports = { getBills, getBill };