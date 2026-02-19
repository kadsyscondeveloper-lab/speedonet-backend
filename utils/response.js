/**
 * Unified API response format
 * { success, message, data, meta }
 */

const ok = (res, data = null, message = 'Success', statusCode = 200, meta = null) => {
  const body = { success: true, message };
  if (data !== null) body.data = data;
  if (meta !== null) body.meta = meta;
  return res.status(statusCode).json(body);
};

const created = (res, data = null, message = 'Created') =>
  ok(res, data, message, 201);

const error = (res, message = 'Something went wrong', statusCode = 500, errors = null) => {
  const body = { success: false, message };
  if (errors) body.errors = errors;
  return res.status(statusCode).json(body);
};

const badRequest  = (res, message = 'Bad request', errors = null) =>
  error(res, message, 400, errors);

const unauthorized = (res, message = 'Unauthorized') =>
  error(res, message, 401);

const forbidden = (res, message = 'Forbidden') =>
  error(res, message, 403);

const notFound = (res, message = 'Not found') =>
  error(res, message, 404);

const conflict = (res, message = 'Conflict') =>
  error(res, message, 409);

const tooMany = (res, message = 'Too many requests') =>
  error(res, message, 429);

module.exports = { ok, created, error, badRequest, unauthorized, forbidden, notFound, conflict, tooMany };