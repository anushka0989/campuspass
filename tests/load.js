import pg from 'pg';
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const BASE = 'http://localhost:3000';
const ROUTE = process.argv[2] || 'book';   // later: book-atomic, book-lock
const SEATS = 100, USERS = 500;

// seed: 1 organizer, 500 students, 1 event with 100 seats
await pool.query('TRUNCATE bookings, events, users RESTART IDENTITY CASCADE');
await pool.query(`INSERT INTO users (name, email, role) VALUES ('Org','org@x.com','organizer')`);
await pool.query(
  `INSERT INTO users (name, email)
   SELECT 'S' || g, 's' || g || '@x.com' FROM generate_series(1, $1::int) g`, [USERS]);
await pool.query(
  `INSERT INTO events (organizer_id, title, starts_at, capacity, seats_left)
   VALUES (1, 'Load test', now() + interval '1 day', $1::int, $1::int)`, [SEATS]);

// fire all requests at once (student ids are 2..501)
const t0 = performance.now();
const statuses = await Promise.all(Array.from({ length: USERS }, (_, i) =>
  fetch(`${BASE}/events/1/${ROUTE}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ userId: i + 2 }),
  }).then(r => r.status).catch(() => 'ERR')));
const ms = Math.round(performance.now() - t0);

const tally = {};
for (const s of statuses) tally[s] = (tally[s] || 0) + 1;

const { rows: [ev] } = await pool.query('SELECT seats_left FROM events WHERE id = 1');
const { rows: [b] } = await pool.query(
  `SELECT count(*)::int AS n FROM bookings WHERE event_id = 1 AND status = 'confirmed'`);

console.log({ route: ROUTE, tally, ms, seats_left: ev.seats_left, confirmed_bookings: b.n });

const ok = tally[201] === SEATS && tally[409] === USERS - SEATS
  && !tally[500] && !tally.ERR && ev.seats_left === 0 && b.n === SEATS;
console.log(ok ? 'PASS' : 'FAIL');
await pool.end();
process.exit(ok ? 0 : 1);