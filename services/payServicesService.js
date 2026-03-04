// services/payServicesService.js
const { db, sql } = require('../config/db');

// ─────────────────────────────────────────────────────────────────────────────
// APP — fetch enabled services WITH their enabled providers
// Response shape:
// {
//   recharge:     [{ id, icon, label, providers: ['name1', ...] }],
//   bill_payment: [{ id, icon, label, providers: ['name1', ...] }]
// }
// ─────────────────────────────────────────────────────────────────────────────
async function getEnabledServices() {
  // 1. Get all enabled services
  const services = await db
    .selectFrom('dbo.pay_services')
    .select(['id', 'icon', 'label', 'section', 'sort_order'])
    .where('is_enabled', '=', true)
    .orderBy('section',    'asc')
    .orderBy('sort_order', 'asc')
    .execute();

  if (services.length === 0) {
    return { recharge: [], bill_payment: [] };
  }

  // 2. Get all enabled providers for those service IDs in one query
  const serviceIds = services.map(s => s.id);
  const providers  = await db
    .selectFrom('dbo.pay_service_providers')
    .select(['service_id', 'name', 'icon_data', 'icon_mime'])
    .where('service_id', 'in', serviceIds)
    .where('is_enabled', '=', true)
    .orderBy('sort_order', 'asc')
    .execute();

  // 3. Group providers by service_id
  const providerMap = {};
  for (const p of providers) {
    const sid = Number(p.service_id);
    if (!providerMap[sid]) providerMap[sid] = [];
    providerMap[sid].push({
  name:      p.name,
  icon_data: p.icon_data || null,
  icon_mime: p.icon_mime || null,
});
  }

  // 4. Attach providers to each service and split by section
  const withProviders = services.map(s => ({
    id:        s.id,
    icon:      s.icon,
    label:     s.label,
    providers: providerMap[s.id] || [],
  }));

  return {
    recharge:     withProviders.filter(s => services.find(r => r.id === s.id)?.section === 'recharge'),
    bill_payment: withProviders.filter(s => services.find(r => r.id === s.id)?.section === 'bill_payment'),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// ADMIN — all services with all providers (including disabled)
// ─────────────────────────────────────────────────────────────────────────────
async function getAllServices() {
  const services = await db
    .selectFrom('dbo.pay_services')
    .select(['id', 'icon', 'label', 'section', 'sort_order', 'is_enabled'])
    .orderBy('section',    'asc')
    .orderBy('sort_order', 'asc')
    .execute();

  if (services.length === 0) return [];

  const serviceIds = services.map(s => s.id);
  const providers = await db
  .selectFrom('dbo.pay_service_providers')
  .select(['id', 'service_id', 'name', 'sort_order', 'is_enabled', 'icon_data', 'icon_mime']) // ← add both
  .where('service_id', 'in', serviceIds)
  .orderBy('sort_order', 'asc')
  .execute();

  const providerMap = {};
  for (const p of providers) {
    const sid = Number(p.service_id);
    if (!providerMap[sid]) providerMap[sid] = [];
    providerMap[sid].push({
  id:         p.id,
  name:       p.name,
  sort_order: p.sort_order,
  is_enabled: p.is_enabled,
  icon_data:  p.icon_data || null,
  icon_mime:  p.icon_mime || null,
});
  }

  return services.map(s => ({
    ...s,
    providers: providerMap[s.id] || [],
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
// SERVICE CRUD
// ─────────────────────────────────────────────────────────────────────────────
async function setServiceEnabled(id, isEnabled) {
  const result = await db
    .updateTable('dbo.pay_services')
    .set({ is_enabled: isEnabled, updated_at: sql`SYSUTCDATETIME()` })
    .where('id', '=', id)
    .executeTakeFirst();

  if (!result || Number(result.numUpdatedRows) === 0) {
    throw Object.assign(new Error('Service not found.'), { statusCode: 404 });
  }
}

async function updateSortOrder(id, sortOrder) {
  await db
    .updateTable('dbo.pay_services')
    .set({ sort_order: sortOrder, updated_at: sql`SYSUTCDATETIME()` })
    .where('id', '=', id)
    .execute();
}

async function createService({ icon, label, section, sort_order = 99 }) {
  const VALID_SECTIONS = ['recharge', 'bill_payment'];
  if (!VALID_SECTIONS.includes(section)) {
    throw Object.assign(new Error(`section must be one of: ${VALID_SECTIONS.join(', ')}`), { statusCode: 400 });
  }
  return db
    .insertInto('dbo.pay_services')
    .values({ icon, label, section, sort_order, is_enabled: true })
    .output(['inserted.id', 'inserted.icon', 'inserted.label', 'inserted.section'])
    .executeTakeFirstOrThrow();
}

async function deleteService(id) {
  // Providers are deleted automatically via ON DELETE CASCADE
  await db.deleteFrom('dbo.pay_services').where('id', '=', id).execute();
}

async function updateServiceDetails(id, { label, icon }) {
  const allowed = {};
  if (label) allowed.label = label;
  if (icon)  allowed.icon  = icon;
  if (!Object.keys(allowed).length) return;
  allowed.updated_at = sql`SYSUTCDATETIME()`;
  await db.updateTable('dbo.pay_services').set(allowed).where('id', '=', id).execute();
}

// ─────────────────────────────────────────────────────────────────────────────
// PROVIDER CRUD
// ─────────────────────────────────────────────────────────────────────────────
async function addProvider(serviceId, { name, sort_order = 99, icon_data = null, icon_mime = null }) {
  return db
    .insertInto('dbo.pay_service_providers')
    .values({ service_id: serviceId, name, sort_order, is_enabled: true, icon_data, icon_mime })
    .output(['inserted.id', 'inserted.name', 'inserted.sort_order'])
    .executeTakeFirstOrThrow();
}

async function updateProvider(providerId, updates) {
  const allowed = {};
  if (typeof updates.name       === 'string')  allowed.name       = updates.name;
  if (typeof updates.sort_order === 'number')  allowed.sort_order = updates.sort_order;
  if (typeof updates.is_enabled === 'boolean') allowed.is_enabled = updates.is_enabled;
  if (updates.icon_data !== undefined)         allowed.icon_data  = updates.icon_data;
  if (updates.icon_mime !== undefined)         allowed.icon_mime  = updates.icon_mime;
  

  if (Object.keys(allowed).length === 0) {
    throw Object.assign(new Error('Nothing to update.'), { statusCode: 400 });
  }
  allowed.updated_at = sql`SYSUTCDATETIME()`;

  await db
    .updateTable('dbo.pay_service_providers')
    .set(allowed)
    .where('id', '=', providerId)
    .execute();
}

async function deleteProvider(providerId) {
  await db.deleteFrom('dbo.pay_service_providers').where('id', '=', providerId).execute();
}

module.exports = {
  getEnabledServices,
  getAllServices,
  setServiceEnabled,
  updateSortOrder,
  updateServiceDetails,
  createService,
  deleteService,
  addProvider,
  updateProvider,
  deleteProvider,
};