const config = require('./config');
const express = require('express');
const helmet = require('helmet');
const session = require('express-session');
const PgStore = require('connect-pg-simple')(session);
const bcrypt = require('bcryptjs');
const morgan = require('morgan');
const path = require('path');
const QRCode = require('qrcode');
const pool = require('./db');
const { requireAuth, requireRole } = require('./auth');
const { sendError } = require('./errors');
const limiter = require('./rateLimit');
const bookingService = require('./bookingService');

const app = express();
if (config.isProd) app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
      },
    },
  })
);
if (process.env.NODE_ENV !== 'test') app.use(morgan('dev'));
app.use(express.json({ limit: '50kb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

app.use(
  session({
    store: new PgStore({ pool, createTableIfMissing: true, disableTouch: true }),
    name: 'cp.sid',
    secret: config.sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: 'lax', secure: config.isProd, maxAge: 8 * 60 * 60 * 1000 },
  })
);

// ---------- small helpers ----------
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const me = (req) => req.session.user;

// Every :id in a path must be a positive integer, otherwise 400 (never a database error).
app.param('id', (req, res, next, val) => (/^\d{1,15}$/.test(val) ? next() : sendError(res, 'BAD_INPUT', 'Invalid id.')));

function regenerate(req) {
  return new Promise((resolve, reject) => req.session.regenerate((e) => (e ? reject(e) : resolve())));
}

app.get('/api/health', wrap(async (req, res) => {
  await pool.query('SELECT 1');
  res.json({ ok: true });
}));

// ================= AUTH =================
app.post('/api/auth/register', wrap(async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const role = req.body.role === 'organizer' ? 'organizer' : 'student';

  if (!EMAIL_RE.test(email) || email.length > 255) return sendError(res, 'BAD_INPUT', 'Enter a valid email address.');
  if (password.length < 8 || password.length > 72) return sendError(res, 'BAD_INPUT', 'Use a password of 8 to 72 characters.');
  if (role === 'organizer' && (!config.organizerCode || req.body.inviteCode !== config.organizerCode)) {
    return sendError(res, 'FORBIDDEN', 'A valid organizer invite code is required.');
  }

  try {
    const hash = await bcrypt.hash(password, config.bcryptRounds);
    const r = await pool.query(
      'INSERT INTO users(email, password_hash, role) VALUES($1, $2, $3) RETURNING id, email, role',
      [email, hash, role]
    );
    await regenerate(req);
    req.session.user = r.rows[0];
    res.status(201).json({ user: r.rows[0] });
  } catch (e) {
    if (e.code === '23505') return sendError(res, 'EMAIL_TAKEN');
    throw e;
  }
}));

app.post('/api/auth/login', wrap(async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  if (limiter.isLocked(req, email)) return sendError(res, 'TOO_MANY_ATTEMPTS');

  const r = await pool.query('SELECT id, email, role, password_hash FROM users WHERE email=$1', [email]);
  const ok = r.rowCount > 0 && (await bcrypt.compare(password, r.rows[0].password_hash));
  if (!ok) {
    limiter.recordFailure(req, email);
    return sendError(res, 'BAD_CREDS');
  }
  limiter.clearFailures(req, email);
  await regenerate(req);
  req.session.user = { id: r.rows[0].id, email: r.rows[0].email, role: r.rows[0].role };
  res.json({ user: req.session.user });
}));

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('cp.sid');
    res.json({ ok: true });
  });
});

app.get('/api/auth/me', (req, res) => res.json({ user: req.session.user || null }));

// ================= EVENTS (public) =================
app.get('/api/events', wrap(async (req, res) => {
  const r = await pool.query(
    `SELECT id, title, description, venue, starts_at, total_seats, seats_left, status, requires_approval
       FROM events
      WHERE status IN ('open', 'closed') AND starts_at > now()
      ORDER BY starts_at, id`
  );
  res.json({ events: r.rows });
}));

// ================= EVENTS (organizer) =================
app.post('/api/events', requireAuth, requireRole('organizer'), wrap(async (req, res) => {
  const title = String(req.body.title || '').trim();
  const description = String(req.body.description || '').trim();
  const venue = String(req.body.venue || '').trim();
  const seats = Number(req.body.total_seats);
  const startsAt = new Date(req.body.starts_at);
  const status = req.body.status === 'draft' ? 'draft' : 'open';
  const lockMode = req.body.lock_mode === 'atomic' ? 'atomic' : 'rowlock';
  const requiresApproval = req.body.requires_approval === true;

  if (!title || title.length > 200) return sendError(res, 'BAD_INPUT', 'Give the event a title of up to 200 characters.');
  if (description.length > 2000) return sendError(res, 'BAD_INPUT', 'Keep the description under 2000 characters.');
  if (venue.length > 200) return sendError(res, 'BAD_INPUT', 'Keep the venue under 200 characters.');
  if (!Number.isInteger(seats) || seats < 1 || seats > 100000) return sendError(res, 'BAD_INPUT', 'Seats must be a whole number from 1 to 100000.');
  if (Number.isNaN(startsAt.getTime()) || startsAt.getTime() <= Date.now()) return sendError(res, 'BAD_INPUT', 'Pick a start time in the future.');

  const r = await pool.query(
    `INSERT INTO events(title, description, venue, starts_at, total_seats, seats_left, status, organizer_id, lock_mode, requires_approval)
     VALUES($1, $2, $3, $4, $5, $5, $6, $7, $8, $9) RETURNING *`,
    [title, description || null, venue || null, startsAt.toISOString(), seats, status, me(req).id, lockMode, requiresApproval]
  );
  res.status(201).json({ event: r.rows[0] });
}));

// publish (draft -> open), close bookings (open -> closed), reopen (closed -> open)
app.patch('/api/events/:id/status', requireAuth, requireRole('organizer'), wrap(async (req, res) => {
  const status = req.body.status;
  if (!['open', 'closed'].includes(status)) return sendError(res, 'BAD_INPUT', 'Status must be "open" or "closed".');
  const r = await pool.query(
    `UPDATE events SET status=$1 WHERE id=$2 AND organizer_id=$3 RETURNING id, status`,
    [status, req.params.id, me(req).id]
  );
  if (!r.rowCount) return sendError(res, 'NOT_FOUND', 'Event not found.');
  res.json({ event: r.rows[0] });
}));

app.patch('/api/events/:id/settings', requireAuth, requireRole('organizer'), wrap(async (req, res) => {
  const { lock_mode, requires_approval } = req.body;
  if (lock_mode !== undefined && !['rowlock', 'atomic'].includes(lock_mode)) return sendError(res, 'BAD_INPUT', 'Locking mode must be "rowlock" or "atomic".');
  if (requires_approval !== undefined && typeof requires_approval !== 'boolean') return sendError(res, 'BAD_INPUT', 'requires_approval must be true or false.');
  const out = await bookingService.updateSettings(Number(req.params.id), me(req).id, { lock_mode, requires_approval });
  if (!out.ok) return sendError(res, out.code);
  res.json(out);
}));

app.post('/api/bookings/:id/approve', requireAuth, requireRole('organizer'), wrap(async (req, res) => {
  const out = await bookingService.approveBooking(Number(req.params.id), me(req).id);
  if (!out.ok) return sendError(res, out.code);
  res.json({ ok: true });
}));

// organizer overrides: change capacity, or book a seat for a student by email
app.patch('/api/events/:id/capacity', requireAuth, requireRole('organizer'), wrap(async (req, res) => {
  const total = Number(req.body.total_seats);
  if (!Number.isInteger(total) || total < 1 || total > 100000) return sendError(res, 'BAD_INPUT', 'Seats must be a whole number from 1 to 100000.');
  const out = await bookingService.setCapacity(Number(req.params.id), me(req).id, total);
  if (!out.ok) return sendError(res, out.code);
  res.json(out);
}));

app.post('/api/events/:id/bookings', requireAuth, requireRole('organizer'), wrap(async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  if (!email) return sendError(res, 'BAD_INPUT', 'Enter the student email.');
  const out = await bookingService.organizerBook(Number(req.params.id), me(req).id, email);
  if (!out.ok) return sendError(res, out.code);
  res.status(201).json(out);
}));

app.delete('/api/events/:id', requireAuth, requireRole('organizer'), wrap(async (req, res) => {
  const out = await bookingService.deleteEvent(Number(req.params.id), me(req).id);
  if (!out.ok) return sendError(res, out.code, 'Event not found.');
  res.json({ ok: true, removed_bookings: out.removed_bookings });
}));

app.get('/api/organizer/events', requireAuth, requireRole('organizer'), wrap(async (req, res) => {
  const r = await pool.query(
    `SELECT e.id, e.title, e.venue, e.starts_at, e.total_seats, e.seats_left, e.status, e.lock_mode, e.requires_approval,
            (SELECT count(*) FROM bookings b WHERE b.event_id=e.id AND b.status='pending')::int AS pending,
            (SELECT count(*) FROM bookings b WHERE b.event_id=e.id AND b.status IN ('pending','confirmed','checked_in'))::int AS booked,
            (SELECT count(*) FROM bookings b WHERE b.event_id=e.id AND b.status='checked_in')::int AS checked_in,
            (SELECT count(*) FROM waitlist w WHERE w.event_id=e.id)::int AS waiting
       FROM events e WHERE e.organizer_id=$1
      ORDER BY e.starts_at DESC, e.id DESC`,
    [me(req).id]
  );
  res.json({ events: r.rows });
}));

app.get('/api/events/:id/dashboard', requireAuth, requireRole('organizer'), wrap(async (req, res) => {
  const ev = await pool.query('SELECT * FROM events WHERE id=$1 AND organizer_id=$2', [req.params.id, me(req).id]);
  if (!ev.rowCount) return sendError(res, 'NOT_FOUND', 'Event not found.');

  const bookings = await pool.query(
    `SELECT b.id, b.status, b.created_at, b.checked_in_at, b.qr_token, u.email
       FROM bookings b JOIN users u ON u.id=b.student_id
      WHERE b.event_id=$1 ORDER BY b.id`,
    [req.params.id]
  );
  const wl = await pool.query('SELECT count(*)::int AS n FROM waitlist WHERE event_id=$1', [req.params.id]);
  const rec = await pool.query('SELECT active_bookings, ok FROM event_reconciliation WHERE id=$1', [req.params.id]);
  res.json({
    event: ev.rows[0],
    bookings: bookings.rows,
    waitlist_count: wl.rows[0].n,
    reconciliation: { active_bookings: rec.rows[0].active_bookings, ok: rec.rows[0].ok },
  });
}));

// Does seats_left + active bookings equal total_seats?
app.get('/api/events/:id/reconcile', requireAuth, requireRole('organizer'), wrap(async (req, res) => {
  const r = await pool.query(
    `SELECT r.id, r.total_seats, r.seats_left, r.active_bookings, r.ok
       FROM event_reconciliation r JOIN events e ON e.id=r.id
      WHERE r.id=$1 AND e.organizer_id=$2`,
    [req.params.id, me(req).id]
  );
  if (!r.rowCount) return sendError(res, 'NOT_FOUND', 'Event not found.');
  res.json(r.rows[0]);
}));

// ================= BOOKING =================
const STRATEGIES = {
  rowlock: bookingService.bookSeatWithRowLock,
  atomic: bookingService.bookSeatWithAtomicUpdate,
  naive: bookingService.bookSeatNaive,
};

app.post('/api/events/:id/book', requireAuth, requireRole('student'), wrap(async (req, res) => {
  const requested = req.query.strategy;
  const ev = await pool.query('SELECT lock_mode FROM events WHERE id=$1', [req.params.id]);
  let name = ev.rowCount && ev.rows[0].lock_mode === 'atomic' ? 'atomic' : 'rowlock';
  if (requested === 'rowlock') name = 'rowlock';
  if (requested === 'atomic') name = 'atomic';
  if (requested === 'naive' && config.allowNaive) name = 'naive';

  const out = await STRATEGIES[name](Number(req.params.id), me(req).id);
  if (!out.ok) return sendError(res, out.code);
  res.status(201).json({ booking: { bookingId: out.bookingId, status: out.status } });
}));

app.get('/api/bookings/mine', requireAuth, requireRole('student'), wrap(async (req, res) => {
  const r = await pool.query(
    `SELECT b.id, b.status, b.created_at, b.qr_token,
            e.id AS event_id, e.title, e.venue, e.starts_at
       FROM bookings b JOIN events e ON e.id=b.event_id
      WHERE b.student_id=$1
      ORDER BY e.starts_at, b.id`,
    [me(req).id]
  );
  res.json({ bookings: r.rows });
}));

// QR code image for a confirmed ticket (owner only)
app.get('/api/bookings/:id/qr', requireAuth, wrap(async (req, res) => {
  const r = await pool.query('SELECT qr_token, status FROM bookings WHERE id=$1 AND student_id=$2', [req.params.id, me(req).id]);
  if (!r.rowCount || r.rows[0].status !== 'confirmed') return sendError(res, 'NOT_FOUND', 'Ticket not found.');
  const png = await QRCode.toBuffer(r.rows[0].qr_token, { width: 260, margin: 1, errorCorrectionLevel: 'M' });
  res.type('png').set('Cache-Control', 'private, max-age=300').send(png);
}));

app.delete('/api/bookings/:id', requireAuth, wrap(async (req, res) => {
  const out = await bookingService.cancelBooking(Number(req.params.id), me(req));
  if (!out.ok) return sendError(res, out.code);
  res.json({ ok: true, promoted: Boolean(out.promoted) });
}));

// ================= WAITLIST =================
app.post('/api/events/:id/waitlist', requireAuth, requireRole('student'), wrap(async (req, res) => {
  const out = await bookingService.joinWaitlist(Number(req.params.id), me(req).id);
  if (!out.ok) return sendError(res, out.code);
  res.status(201).json({ ok: true, position: out.position });
}));

app.delete('/api/events/:id/waitlist', requireAuth, requireRole('student'), wrap(async (req, res) => {
  const out = await bookingService.leaveWaitlist(Number(req.params.id), me(req).id);
  if (!out.ok) return sendError(res, 'NOT_FOUND', 'You are not on this waitlist.');
  res.json({ ok: true });
}));

app.get('/api/waitlist/mine', requireAuth, requireRole('student'), wrap(async (req, res) => {
  const r = await pool.query(
    `SELECT w.event_id, e.title, e.venue, e.starts_at,
            (SELECT count(*) FROM waitlist w2 WHERE w2.event_id=w.event_id AND w2.id <= w.id)::int AS position
       FROM waitlist w JOIN events e ON e.id=w.event_id
      WHERE w.student_id=$1 ORDER BY e.starts_at`,
    [me(req).id]
  );
  res.json({ waitlist: r.rows });
}));

// ================= CHECK-IN (HMAC-verified) =================
app.post('/api/checkin/:token', requireAuth, requireRole('organizer'), wrap(async (req, res) => {
  const t = bookingService.verifyQrToken(req.params.token);
  if (!t) return sendError(res, 'BAD_TOKEN');

  const r = await pool.query(
    `UPDATE bookings b SET status='checked_in', checked_in_at=now()
       FROM events e
      WHERE b.id=$1 AND b.event_id=e.id AND e.id=$2 AND e.organizer_id=$3 AND b.status='confirmed'
      RETURNING b.id, b.event_id, e.title, (SELECT email FROM users WHERE id=b.student_id) AS email`,
    [t.bookingId, t.eventId, me(req).id]
  );
  if (r.rowCount) return res.json({ ok: true, booking: r.rows[0] });

  // Say exactly why it was refused.
  const info = await pool.query(
    `SELECT b.status, e.organizer_id FROM bookings b JOIN events e ON e.id=b.event_id WHERE b.id=$1 AND b.event_id=$2`,
    [t.bookingId, t.eventId]
  );
  if (!info.rowCount) return sendError(res, 'NOT_FOUND', 'No booking matches this code.');
  if (String(info.rows[0].organizer_id) !== String(me(req).id)) return sendError(res, 'FORBIDDEN', "This ticket is for another organizer's event.");
  if (info.rows[0].status === 'checked_in') return sendError(res, 'ALREADY_CHECKED_IN');
  if (info.rows[0].status === 'cancelled') return sendError(res, 'CANCELLED');
  return sendError(res, 'INVALID_STATE', 'This ticket cannot be checked in.');
}));

// ================= fallthrough + errors =================
app.use('/api', (req, res) => sendError(res, 'NOT_FOUND', 'Unknown endpoint.'));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') return sendError(res, 'BAD_INPUT', 'Request body is not valid JSON.');
  console.error(`[error] ${req.method} ${req.originalUrl}:`, err);
  sendError(res, 'INTERNAL'); // never leak err.message to the client
});

if (require.main === module) {
  const server = app.listen(config.port, () => console.log(`CampusPass running on http://localhost:${config.port}`));
  const shutdown = () => server.close(() => pool.end().finally(() => process.exit(0)));
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

module.exports = app;