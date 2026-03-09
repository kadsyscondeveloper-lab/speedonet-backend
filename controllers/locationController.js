// controllers/locationController.js
const { db, sql } = require('../config/db');
const R           = require('../utils/response');

// ═══════════════════════════════════════════════════════════════════
// PUBLIC — used by Flutter app
// ═══════════════════════════════════════════════════════════════════

// GET /api/v1/locations/states
async function getStates(req, res, next) {
  try {
    const rows = await db
      .selectFrom('dbo.states')
      .select(['id', 'name'])
      .where('is_active', '=', true)
      .orderBy('sort_order', 'asc')
      .orderBy('name', 'asc')
      .execute();

    return R.ok(res, { states: rows.map(r => r.name) });
  } catch (err) { next(err); }
}

// GET /api/v1/locations/cities?state=Maharashtra
async function getCities(req, res, next) {
  try {
    const { state } = req.query;

    let query = db
      .selectFrom('dbo.cities as c')
      .innerJoin('dbo.states as s', 's.id', 'c.state_id')
      .select(['c.name'])
      .where('c.is_active', '=', true)
      .where('s.is_active', '=', true)
      .orderBy('c.sort_order', 'asc')
      .orderBy('c.name',      'asc');

    if (state) {
      query = query.where('s.name', '=', state);
    }

    const rows = await query.execute();
    return R.ok(res, { cities: rows.map(r => r.name) });
  } catch (err) { next(err); }
}

// ═══════════════════════════════════════════════════════════════════
// ADMIN — full CRUD
// ═══════════════════════════════════════════════════════════════════

// GET /api/v1/admin/locations/states  — all states with city counts
async function adminGetStates(req, res, next) {
  try {
    const rows = await sql`
      SELECT
        s.id, s.name, s.sort_order, s.is_active,
        COUNT(c.id) AS city_count
      FROM dbo.states s
      LEFT JOIN dbo.cities c ON c.state_id = s.id
      GROUP BY s.id, s.name, s.sort_order, s.is_active
      ORDER BY s.sort_order ASC, s.name ASC
    `.execute(db).then(r => r.rows);

    return R.ok(res, { states: rows });
  } catch (err) { next(err); }
}

// GET /api/v1/admin/locations/states/:stateId/cities
async function adminGetCities(req, res, next) {
  try {
    const stateId = parseInt(req.params.stateId);
    if (isNaN(stateId)) return R.badRequest(res, 'Invalid state ID.');

    const cities = await db
      .selectFrom('dbo.cities')
      .select(['id', 'name', 'sort_order', 'is_active'])
      .where('state_id', '=', stateId)
      .orderBy('sort_order', 'asc')
      .orderBy('name',       'asc')
      .execute();

    return R.ok(res, { cities });
  } catch (err) { next(err); }
}

// POST /api/v1/admin/locations/states  — add a state
async function adminAddState(req, res, next) {
  try {
    const { name, sort_order = 99 } = req.body;
    if (!name?.trim()) return R.badRequest(res, 'State name is required.');

    const row = await db
      .insertInto('dbo.states')
      .values({ name: name.trim(), sort_order })
      .output(['inserted.id', 'inserted.name', 'inserted.sort_order', 'inserted.is_active'])
      .executeTakeFirstOrThrow();

    return R.created(res, { state: row }, 'State added.');
  } catch (err) {
    if (err.number === 2627 || err.number === 2601)
      return R.conflict(res, 'A state with this name already exists.');
    next(err);
  }
}

// PATCH /api/v1/admin/locations/states/:stateId
async function adminUpdateState(req, res, next) {
  try {
    const stateId = parseInt(req.params.stateId);
    if (isNaN(stateId)) return R.badRequest(res, 'Invalid state ID.');

    const allowed = {};
    if (req.body.name       != null) allowed.name       = req.body.name.trim();
    if (req.body.sort_order != null) allowed.sort_order = parseInt(req.body.sort_order);
    if (typeof req.body.is_active === 'boolean') allowed.is_active = req.body.is_active;

    if (!Object.keys(allowed).length) return R.badRequest(res, 'Nothing to update.');

    await db
      .updateTable('dbo.states')
      .set(allowed)
      .where('id', '=', stateId)
      .execute();

    return R.ok(res, null, 'State updated.');
  } catch (err) {
    if (err.number === 2627 || err.number === 2601)
      return R.conflict(res, 'A state with this name already exists.');
    next(err);
  }
}

// DELETE /api/v1/admin/locations/states/:stateId
// Cascades — deletes all cities in that state too
async function adminDeleteState(req, res, next) {
  try {
    const stateId = parseInt(req.params.stateId);
    if (isNaN(stateId)) return R.badRequest(res, 'Invalid state ID.');

    await db.deleteFrom('dbo.states').where('id', '=', stateId).execute();
    return R.ok(res, null, 'State and all its cities deleted.');
  } catch (err) { next(err); }
}

// POST /api/v1/admin/locations/states/:stateId/cities
async function adminAddCity(req, res, next) {
  try {
    const stateId = parseInt(req.params.stateId);
    if (isNaN(stateId)) return R.badRequest(res, 'Invalid state ID.');

    const { name, sort_order = 99 } = req.body;
    if (!name?.trim()) return R.badRequest(res, 'City name is required.');

    const row = await db
      .insertInto('dbo.cities')
      .values({ state_id: stateId, name: name.trim(), sort_order })
      .output(['inserted.id', 'inserted.name', 'inserted.sort_order', 'inserted.is_active'])
      .executeTakeFirstOrThrow();

    return R.created(res, { city: row }, 'City added.');
  } catch (err) {
    if (err.number === 2627 || err.number === 2601)
      return R.conflict(res, 'This city already exists in the selected state.');
    next(err);
  }
}

// PATCH /api/v1/admin/locations/cities/:cityId
async function adminUpdateCity(req, res, next) {
  try {
    const cityId = parseInt(req.params.cityId);
    if (isNaN(cityId)) return R.badRequest(res, 'Invalid city ID.');

    const allowed = {};
    if (req.body.name       != null) allowed.name       = req.body.name.trim();
    if (req.body.sort_order != null) allowed.sort_order = parseInt(req.body.sort_order);
    if (typeof req.body.is_active === 'boolean') allowed.is_active = req.body.is_active;

    if (!Object.keys(allowed).length) return R.badRequest(res, 'Nothing to update.');

    await db
      .updateTable('dbo.cities')
      .set(allowed)
      .where('id', '=', cityId)
      .execute();

    return R.ok(res, null, 'City updated.');
  } catch (err) { next(err); }
}

// DELETE /api/v1/admin/locations/cities/:cityId
async function adminDeleteCity(req, res, next) {
  try {
    const cityId = parseInt(req.params.cityId);
    if (isNaN(cityId)) return R.badRequest(res, 'Invalid city ID.');

    await db.deleteFrom('dbo.cities').where('id', '=', cityId).execute();
    return R.ok(res, null, 'City deleted.');
  } catch (err) { next(err); }
}

module.exports = {
  // Public
  getStates,
  getCities,
  // Admin
  adminGetStates,
  adminGetCities,
  adminAddState,
  adminUpdateState,
  adminDeleteState,
  adminAddCity,
  adminUpdateCity,
  adminDeleteCity,
};