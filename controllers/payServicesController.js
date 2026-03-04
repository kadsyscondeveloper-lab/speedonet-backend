// controllers/payServicesController.js
const payServicesService = require('../services/payServicesService');
const R                  = require('../utils/response');

// ── App ───────────────────────────────────────────────────────────────────────

// GET /api/v1/pay/services
async function getServices(req, res, next) {
  try {
    const data = await payServicesService.getEnabledServices();
    return R.ok(res, data);
  } catch (err) { next(err); }
}

// ── Admin: Services ───────────────────────────────────────────────────────────

// GET /api/v1/admin/pay-services
async function getAllServices(req, res, next) {
  try {
    const services = await payServicesService.getAllServices();
    return R.ok(res, { services });
  } catch (err) { next(err); }
}

// POST /api/v1/admin/pay-services
// Body: { icon, label, section, sort_order? }
async function createService(req, res, next) {
  try {
    const { icon, label, section, sort_order } = req.body;
    if (!icon || !label || !section) {
      return R.badRequest(res, 'icon, label and section are required.');
    }
    const service = await payServicesService.createService({ icon, label, section, sort_order });
    return R.created(res, { service }, 'Service created.');
  } catch (err) {
    if (err.statusCode) return R.error(res, err.message, err.statusCode);
    next(err);
  }
}

// PATCH /api/v1/admin/pay-services/:id
// Body: { is_enabled?, sort_order? }
async function updateService(req, res, next) {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return R.badRequest(res, 'Invalid service ID.');

    const { is_enabled, sort_order, label, icon } = req.body;
    if (typeof is_enabled === 'boolean') await payServicesService.setServiceEnabled(id, is_enabled);
    if (typeof sort_order === 'number')  await payServicesService.updateSortOrder(id, sort_order);
    if (label || icon)                   await payServicesService.updateServiceDetails(id, { label, icon });

    return R.ok(res, null, 'Service updated.');
  } catch (err) {
    if (err.statusCode) return R.error(res, err.message, err.statusCode);
    next(err);
  }
}

// DELETE /api/v1/admin/pay-services/:id
async function deleteService(req, res, next) {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return R.badRequest(res, 'Invalid service ID.');
    await payServicesService.deleteService(id);
    return R.ok(res, null, 'Service and its providers deleted.');
  } catch (err) { next(err); }
}

// ── Admin: Providers ──────────────────────────────────────────────────────────

// POST /api/v1/admin/pay-services/:id/providers
// Body: { name, sort_order? }
async function addProvider(req, res, next) {
  try {
    const serviceId = parseInt(req.params.id);
    if (isNaN(serviceId)) return R.badRequest(res, 'Invalid service ID.');

    const { name, sort_order, icon_data, icon_mime } = req.body; // ← add icon fields
    if (!name?.trim()) return R.badRequest(res, 'name is required.');

    const provider = await payServicesService.addProvider(serviceId, {
      name: name.trim(),
      sort_order,
      icon_data: icon_data || null,   // ← pass through
      icon_mime: icon_mime || null,
    });
    return R.created(res, { provider }, 'Provider added.');
  } catch (err) { next(err); }
}

// PATCH /api/v1/admin/pay-services/providers/:providerId
// Body: { name?, sort_order?, is_enabled? }
async function updateProvider(req, res, next) {
  try {
    const providerId = parseInt(req.params.providerId);
    if (isNaN(providerId)) return R.badRequest(res, 'Invalid provider ID.');

    await payServicesService.updateProvider(providerId, req.body);
    return R.ok(res, null, 'Provider updated.');
  } catch (err) {
    if (err.statusCode) return R.error(res, err.message, err.statusCode);
    next(err);
  }
}

// DELETE /api/v1/admin/pay-services/providers/:providerId
async function deleteProvider(req, res, next) {
  try {
    const providerId = parseInt(req.params.providerId);
    if (isNaN(providerId)) return R.badRequest(res, 'Invalid provider ID.');

    await payServicesService.deleteProvider(providerId);
    return R.ok(res, null, 'Provider deleted.');
  } catch (err) { next(err); }
}

module.exports = {
  getServices,
  getAllServices,
  createService,
  updateService,
  deleteService,
  addProvider,
  updateProvider,
  deleteProvider,
};