// Shared helpers for the test scripts. Every script talks to a RUNNING server (BASE_URL)
// and uses the database directly only to clean up and to check ground truth.
require('dotenv').config();

const BASE = process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`;
const PASSWORD = 'password123';

// ---------- HTTP ----------
async function http(method, path, { cookie, body } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* empty body */ }
  const setCookie = res.headers.get('set-cookie');
  return { status: res.status, data, cookie: setCookie ? setCookie.split(';')[0] : null };
}

async function login(email, password = PASSWORD) {
  const r = await http('POST', '/api/auth/login', { body: { email, password } });
  if (r.status !== 200) throw new Error(`login failed for ${email}: ${r.status} ${JSON.stringify(r.data)}`);
  return r.cookie;
}

async function ensureStudent(email) {
  let r = await http('POST', '/api/auth/login', { body: { email, password: PASSWORD } });
  if (r.status === 200) return r.cookie;
  r = await http('POST', '/api/auth/register', { body: { email, password: PASSWORD, role: 'student' } });
  if (r.status !== 201) throw new Error(`could not create ${email}: ${r.status} ${JSON.stringify(r.data)}`);
  return r.cookie;
}

const orgLogin = () => login('org@test.com');

async function createEvent(orgCookie, { seats = 1, title = 'event', status = 'open', daysAhead = 1 } = {}) {
  const r = await http('POST', '/api/events', {
    cookie: orgCookie,
    body: {
      title: `[test] ${title} ${Date.now()}`,
      description: 'Created by an automated test.',
      venue: 'Test Hall',
      starts_at: new Date(Date.now() + daysAhead * 86400000).toISOString(),
      total_seats: seats,
      status,
    },
  });
  if (r.status !== 201) throw new Error(`could not create event: ${r.status} ${JSON.stringify(r.data)}`);
  return Number(r.data.event.id);
}

const book = (eventId, cookie, strategy) =>
  http('POST', `/api/events/${eventId}/book${strategy ? `?strategy=${strategy}` : ''}`, { cookie });
const cancel = (bookingId, cookie) => http('DELETE', `/api/bookings/${bookingId}`, { cookie });
const joinWaitlist = (eventId, cookie) => http('POST', `/api/events/${eventId}/waitlist`, { cookie });
const myBookings = async (cookie) => (await http('GET', '/api/bookings/mine', { cookie })).data.bookings;
const dashboard = async (eventId, orgCookie) => (await http('GET', `/api/events/${eventId}/dashboard`, { cookie: orgCookie })).data;

// ---------- concurrency ----------
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        out[i] = await fn(items[i], i);
      }
    })
  );
  return out;
}

// n reusable test students (created on first use, then just logged in)
async function students(prefix, n) {
  const emails = Array.from({ length: n }, (_, i) => `${prefix}_${i}@loadtest.local`);
  const cookies = await mapLimit(emails, 25, ensureStudent);
  return emails.map((email, i) => ({ email, cookie: cookies[i] }));
}

// One timed booking request. Always drains the body so connections are released.
async function timedBook(eventId, cookie, strategy) {
  const t0 = performance.now();
  let status = 'ERR';
  try {
    const res = await fetch(`${BASE}/api/events/${eventId}/book${strategy ? `?strategy=${strategy}` : ''}`, {
      method: 'POST',
      headers: { Cookie: cookie },
    });
    await res.text();
    status = res.status;
  } catch { /* network error stays ERR */ }
  return { status, ms: performance.now() - t0 };
}

// Fires every request at once and returns timing + status tally.
async function fireAll(eventId, cookies, strategy) {
  const t0 = performance.now();
  const results = await Promise.all(cookies.map((c) => timedBook(eventId, c, strategy)));
  const totalMs = performance.now() - t0;
  const tally = {};
  for (const r of results) tally[r.status] = (tally[r.status] || 0) + 1;
  const lat = results.map((r) => r.ms).sort((a, b) => a - b);
  return {
    tally,
    totalMs,
    rps: results.length / (totalMs / 1000),
    p50: percentile(lat, 50),
    p95: percentile(lat, 95),
  };
}

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

const median = (arr) => percentile([...arr].sort((a, b) => a - b), 50);

// ---------- database (ground truth + cleanup) ----------
let _pool = null;
const db = () => (_pool ||= require('../server/db'));

async function cleanupEvents(ids) {
  if (!ids.length) return;
  const pool = db();
  await pool.query('DELETE FROM waitlist WHERE event_id = ANY($1::bigint[])', [ids]);
  await pool.query('DELETE FROM bookings WHERE event_id = ANY($1::bigint[])', [ids]);
  await pool.query('DELETE FROM events WHERE id = ANY($1::bigint[])', [ids]);
}

async function reconcile(eventId) {
  const r = await db().query('SELECT * FROM event_reconciliation WHERE id=$1', [eventId]);
  return r.rows[0];
}

const closeDb = async () => { if (_pool) await _pool.end(); _pool = null; };

// ---------- assertions + runner ----------
function checker() {
  let failed = 0;
  return {
    check(label, cond, detail = '') {
      if (cond) console.log(`  ok   ${label}`);
      else { failed += 1; console.log(`  FAIL ${label}${detail ? `   (${detail})` : ''}`); }
      return Boolean(cond);
    },
    get failed() { return failed; },
  };
}

async function run(name, fn) {
  const t = checker();
  let code = 1;
  try {
    console.log(`\n== ${name}`);
    await fn(t);
    code = t.failed === 0 ? 0 : 1;
    console.log(code === 0 ? `PASS  ${name}` : `FAIL  ${name} (${t.failed} failed check${t.failed > 1 ? 's' : ''})`);
  } catch (e) {
    console.error(`  error: ${e.stack || e.message}`);
    console.log(`FAIL  ${name} (exception)`);
  } finally {
    await closeDb().catch(() => {});
  }
  process.exit(code);
}

module.exports = {
  BASE, PASSWORD, http, login, ensureStudent, orgLogin, createEvent, book, cancel, joinWaitlist,
  myBookings, dashboard, mapLimit, students, timedBook, fireAll, percentile, median,
  db, cleanupEvents, reconcile, closeDb, checker, run,
};
