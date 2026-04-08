/**
 * socket/trackingSocket.js
 *
 * Live technician location tracking via Socket.io.
 *
 * HOW IT WORKS:
 *   1. Technician app connects to Socket.io with their JWT.
 *   2. Server authenticates & joins them to their own room: `tech:{id}`
 *   3. Technician emits `location:update { ticket_id, lat, lng }` periodically.
 *   4. Server saves the location to DB + broadcasts to room `ticket:{ticket_id}`.
 *   5. User app connects with their JWT, calls `track:ticket { ticket_id }`.
 *   6. Server validates they own that ticket, joins them to `ticket:{ticket_id}`.
 *   7. User receives `technician:location { lat, lng, updated_at }` in real time.
 *
 * INSTALL:  npm install socket.io
 */

const { Server }  = require('socket.io');
const jwt         = require('jsonwebtoken');
const { db, sql } = require('../config/db');
const logger      = require('../utils/logger');

/**
 * Attach Socket.io to the HTTP server.
 * Call this in server.js after creating the HTTP server.
 *
 * @param {import('http').Server} httpServer
 */
function attachTrackingSocket(httpServer) {
  const io = new Server(httpServer, {
    cors: {
      origin:      process.env.NODE_ENV === 'production' ? 'https://speedonet.in' : '*',
      credentials: true,
    },
    // Namespace keeps tracking traffic isolated from any future Socket.io usage
    path: '/socket.io',
  });

  // ── Namespaces ──────────────────────────────────────────────────────────────
  const techNs = io.of('/tracking/technician');
  const userNs = io.of('/tracking/user');

  // ── Technician namespace ────────────────────────────────────────────────────
  techNs.use(authenticateTechnicianSocket);

  techNs.on('connection', (socket) => {
    const techId = socket.technician.id;
    logger.info(`[Socket] Technician ${techId} connected (${socket.id})`);

    // Technician sends location updates
    socket.on('location:update', async (payload) => {
      try {
        const { ticket_id, lat, lng } = payload || {};

        if (!isValidCoord(lat, lng)) {
          return socket.emit('error', { message: 'Invalid lat/lng.' });
        }

        // Upsert live location into DB
        await sql`
          MERGE dbo.technician_live_locations AS target
          USING (VALUES (${techId}, ${ticket_id ?? null}, ${lat}, ${lng}, GETUTCDATE()))
            AS source (technician_id, ticket_id, lat, lng, updated_at)
          ON target.technician_id = source.technician_id
          WHEN MATCHED THEN
            UPDATE SET
              ticket_id  = source.ticket_id,
              lat        = source.lat,
              lng        = source.lng,
              updated_at = source.updated_at
          WHEN NOT MATCHED THEN
            INSERT (technician_id, ticket_id, lat, lng, updated_at)
            VALUES (source.technician_id, source.ticket_id, source.lat, source.lng, source.updated_at);
        `.execute(db);

        // Broadcast to the user watching this ticket
        if (ticket_id) {
          userNs.to(`ticket:${ticket_id}`).emit('technician:location', {
            lat,
            lng,
            updated_at: new Date().toISOString(),
          });
        }
      } catch (err) {
        logger.error('[Socket] location:update error:', err.message);
        socket.emit('error', { message: 'Failed to update location.' });
      }
    });

    socket.on('disconnect', (reason) => {
      logger.info(`[Socket] Technician ${techId} disconnected: ${reason}`);
    });
  });

  // ── User namespace ──────────────────────────────────────────────────────────
  userNs.use(authenticateUserSocket);

  userNs.on('connection', (socket) => {
    const userId = socket.user.id;
    logger.info(`[Socket] User ${userId} connected (${socket.id})`);

    // User subscribes to a specific ticket's tracking
    socket.on('track:ticket', async (payload) => {
      try {
        const { ticket_id } = payload || {};
        if (!ticket_id || isNaN(parseInt(ticket_id))) {
          return socket.emit('error', { message: 'Invalid ticket_id.' });
        }

        // Verify user owns this ticket AND it has an assigned technician
        const ticket = await db
          .selectFrom('dbo.help_tickets')
          .select(['id', 'user_id', 'tech_job_status', 'assigned_technician_id'])
          .where('id',      '=', parseInt(ticket_id))
          .where('user_id', '=', BigInt(userId))
          .executeTakeFirst();

        if (!ticket) {
          return socket.emit('error', { message: 'Ticket not found.' });
        }
        if (ticket.tech_job_status !== 'assigned') {
          return socket.emit('tracking:unavailable', {
            message: 'No technician assigned yet.',
            tech_job_status: ticket.tech_job_status ?? null,
          });
        }

        // Join the room for this ticket
        const room = `ticket:${ticket_id}`;
        socket.join(room);
        logger.info(`[Socket] User ${userId} joined room ${room}`);

        // Send the last known location immediately as a snapshot
        const loc = await db
          .selectFrom('dbo.technician_live_locations')
          .select(['lat', 'lng', 'updated_at'])
          .where('technician_id', '=', ticket.assigned_technician_id)
          .where('ticket_id',     '=', BigInt(ticket_id))
          .executeTakeFirst();

        if (loc) {
          socket.emit('technician:location', {
            lat:        parseFloat(loc.lat),
            lng:        parseFloat(loc.lng),
            updated_at: loc.updated_at,
            is_snapshot: true,
          });
        }

        socket.emit('tracking:started', { ticket_id });
      } catch (err) {
        logger.error('[Socket] track:ticket error:', err.message);
        socket.emit('error', { message: 'Failed to start tracking.' });
      }
    });

    // User can stop tracking (leaves room, saves bandwidth)
    socket.on('track:stop', (payload) => {
      const { ticket_id } = payload || {};
      if (ticket_id) socket.leave(`ticket:${ticket_id}`);
    });

    socket.on('disconnect', (reason) => {
      logger.info(`[Socket] User ${userId} disconnected: ${reason}`);
    });
  });

  logger.info('[Socket.io] Tracking socket attached ✓');
  return io;
}

// ─────────────────────────────────────────────────────────────────────────────
// Socket middleware — authenticate technician via Bearer token
// ─────────────────────────────────────────────────────────────────────────────
async function authenticateTechnicianSocket(socket, next) {
  try {
    const token = extractToken(socket);
    if (!token) return next(new Error('No token provided.'));

    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // Verify technician still exists & is active
    const technician = await db
      .selectFrom('dbo.technicians')
      .select(['id', 'name', 'is_active'])
      .where('id', '=', BigInt(decoded.id ?? decoded.sub))
      .executeTakeFirst();

    if (!technician || !technician.is_active) {
      return next(new Error('Technician account not found or inactive.'));
    }

    socket.technician = { id: Number(technician.id), name: technician.name };
    next();
  } catch {
    next(new Error('Invalid or expired token.'));
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Socket middleware — authenticate user via Bearer token
// ─────────────────────────────────────────────────────────────────────────────
async function authenticateUserSocket(socket, next) {
  try {
    const token = extractToken(socket);
    if (!token) return next(new Error('No token provided.'));

    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    const user = await db
      .selectFrom('dbo.users')
      .select(['id', 'name'])
      .where('id', '=', BigInt(decoded.id ?? decoded.sub))
      .executeTakeFirst();

    if (!user) return next(new Error('User not found.'));

    socket.user = { id: Number(user.id), name: user.name };
    next();
  } catch {
    next(new Error('Invalid or expired token.'));
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────
function extractToken(socket) {
  // Support both "Authorization: Bearer <token>" header and query param ?token=
  const auth = socket.handshake.headers?.authorization || socket.handshake.auth?.token;
  if (auth?.startsWith('Bearer ')) return auth.slice(7);
  return socket.handshake.query?.token || null;
}

function isValidCoord(lat, lng) {
  return (
    typeof lat === 'number' && typeof lng === 'number' &&
    lat >= -90  && lat <= 90 &&
    lng >= -180 && lng <= 180
  );
}

module.exports = { attachTrackingSocket };