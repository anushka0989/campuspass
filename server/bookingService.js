const crypto = require('crypto');
const pool = require('./db');
const config = require('./config');

/*
 * CONCURRENCY DESIGN
 * ------------------
 * Every write that changes seat counts or bookings for an event first takes that
 * event's row lock (row-lock strategy: SELECT ... FOR UPDATE, atomic strategy:
 * UPDATE ... WHERE seats_left > 0, which takes the same lock). The seat counter and
 * the booking row always change inside ONE transaction.
 *
 * Lock order is always:  event row  ->  booking row  ->  student row
 * so two transactions can never wait on each other in a cycle (no deadlocks).
 *
 * The student row is locked (FOR NO KEY UPDATE) only to make the per-student
 * booking limit race-free when one student books several events at once.
 */

// ---------- QR tokens (HMAC-signed) ----------
function sign(payload) {
  return crypto.createHmac('sha256', config.hmacSecret).update(payload).digest('hex');
}

function makeQrToken(bookingId, eventId) {
  const payload = `${bookingId}:${eventId}`;
  return Buffer.from(`${payload}:${sign(payload)}`).toString('base64url');
}

function verifyQrToken(token) {
  try {
    const parts = Buffer.from(String(token), 'base64url').toString('utf8').split(':');
    if (parts.length !== 3) return null;
    const [bookingId, eventId, sig] = parts;
    if (!/^\d+$/.test(bookingId) || !/^\d+$/.test(eventId) || !/^[0-9a-f]{64}$/.test(sig)) return null;
    const given = Buffer.from(sig, 'hex');
    const expected = Buffer.from(sign(`${bookingId}:${eventId}`), 'hex');
    if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
    return { bookingId: Number(bookingId), eventId: Number(eventId) };
  } catch {
    return null;
  }
}

// ---------- helpers ----------
const fail = (code) => ({ ok: false, code });

// Runs fn in a transaction. Returning { ok:false } rolls back; anything else commits.
async function withTx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query(result && result.ok === false ? 'ROLLBACK' : 'COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

// A duplicate-booking unique violation is an expected outcome, not a crash.
function mapDuplicate(e) {
  if (e.code === '23505') return fail('ALREADY_BOOKED');
  throw e;
}

async function insertBooking(client, eventId, studentId, status = 'confirmed') {
  const ins = await client.query(
    `INSERT INTO bookings(event_id, student_id, status) VALUES ($1, $2, $3) RETURNING id`,
    [eventId, studentId, status]
  );
  const bookingId = Number(ins.rows[0].id);
  await client.query('UPDATE bookings SET qr_token=$1 WHERE id=$2', [makeQrToken(bookingId, eventId), bookingId]);
  return bookingId;
}

async function hasActiveBooking(client, eventId, studentId) {
  const r = await client.query(
    `SELECT 1 FROM bookings WHERE event_id=$1 AND student_id=$2 AND status IN ('pending','confirmed','checked_in')`,
    [eventId, studentId]
  );
  return r.rowCount > 0;
}

// Locks the student row, then checks the per-student limit (upcoming confirmed bookings).
async function studentAtLimit(client, studentId) {
  await client.query('SELECT id FROM users WHERE id=$1 FOR NO KEY UPDATE', [studentId]);
  const r = await client.query(
    `SELECT count(*)::int AS n
       FROM bookings b JOIN events e ON e.id = b.event_id
      WHERE b.student_id=$1 AND b.status IN ('pending','confirmed') AND e.starts_at > now()`,
    [studentId]
  );
  return r.rows[0].n >= config.maxActiveBookings;
}

// Why did the atomic UPDATE match nothing?
async function diagnose(client, eventId, studentId) {
  const ev = await client.query('SELECT status FROM events WHERE id=$1', [eventId]);
  if (!ev.rowCount || ev.rows[0].status === 'draft') return 'NOT_FOUND';
  if (ev.rows[0].status !== 'open') return 'BOOKINGS_CLOSED';
  if (await hasActiveBooking(client, eventId, studentId)) return 'ALREADY_BOOKED';
  return 'SOLD_OUT';
}

// ---------- booking strategy 1: row lock (SELECT ... FOR UPDATE) ----------
async function bookSeatWithRowLock(eventId, studentId) {
  try {
    return await withTx(async (c) => {
      const ev = await c.query('SELECT status, seats_left, requires_approval FROM events WHERE id=$1 FOR UPDATE', [eventId]);
      if (!ev.rowCount || ev.rows[0].status === 'draft') return fail('NOT_FOUND');
      if (ev.rows[0].status !== 'open') return fail('BOOKINGS_CLOSED');
      if (await hasActiveBooking(c, eventId, studentId)) return fail('ALREADY_BOOKED');
      if (ev.rows[0].seats_left <= 0) return fail('SOLD_OUT');
      if (await studentAtLimit(c, studentId)) return fail('BOOKING_LIMIT_REACHED');

      const status = ev.rows[0].requires_approval ? 'pending' : 'confirmed';
      const bookingId = await insertBooking(c, eventId, studentId, status);
      await c.query('UPDATE events SET seats_left = seats_left - 1 WHERE id=$1', [eventId]);
      return { ok: true, bookingId, status };
    });
  } catch (e) {
    return mapDuplicate(e);
  }
}

// ---------- booking strategy 2: atomic conditional update ----------
async function bookSeatWithAtomicUpdate(eventId, studentId) {
  try {
    return await withTx(async (c) => {
      const upd = await c.query(
        `UPDATE events SET seats_left = seats_left - 1
          WHERE id=$1 AND status='open' AND seats_left > 0
          RETURNING requires_approval`,
        [eventId]
      );
      if (!upd.rowCount) return fail(await diagnose(c, eventId, studentId));
      if (await studentAtLimit(c, studentId)) return fail('BOOKING_LIMIT_REACHED'); // rolls the decrement back

      const status = upd.rows[0].requires_approval ? 'pending' : 'confirmed';
      const bookingId = await insertBooking(c, eventId, studentId, status);
      return { ok: true, bookingId, status };
    });
  } catch (e) {
    return mapDuplicate(e);
  }
}

// ---------- strategy 3: NAIVE (demonstration only) ----------
// "Check seats, then write" as separate steps with no transaction and no lock.
// This is the bug the scale test exists to catch. Disabled when NODE_ENV=production.
async function bookSeatNaive(eventId, studentId) {
  try {
    const ev = await pool.query('SELECT status, seats_left FROM events WHERE id=$1', [eventId]);
    if (!ev.rowCount || ev.rows[0].status === 'draft') return fail('NOT_FOUND');
    if (ev.rows[0].status !== 'open') return fail('BOOKINGS_CLOSED');
    if (ev.rows[0].seats_left <= 0) return fail('SOLD_OUT');

    const bookingId = await insertBooking(pool, eventId, studentId);
    await pool.query('UPDATE events SET seats_left = seats_left - 1 WHERE id=$1', [eventId]); // may violate CHECK
    return { ok: true, bookingId, status: 'confirmed' };
  } catch (e) {
    return mapDuplicate(e);
  }
}

// ---------- waitlist ----------
async function joinWaitlist(eventId, studentId) {
  return withTx(async (c) => {
    // Same event lock as booking and cancelling, so joining cannot race with a seat being freed.
    const ev = await c.query('SELECT status, seats_left FROM events WHERE id=$1 FOR UPDATE', [eventId]);
    if (!ev.rowCount || ev.rows[0].status === 'draft') return fail('NOT_FOUND');
    if (ev.rows[0].status !== 'open') return fail('BOOKINGS_CLOSED');
    if (ev.rows[0].seats_left > 0) return fail('SEATS_AVAILABLE');
    if (await hasActiveBooking(c, eventId, studentId)) return fail('ALREADY_BOOKED');

    const ins = await c.query(
      `INSERT INTO waitlist(event_id, student_id) VALUES ($1, $2)
       ON CONFLICT (event_id, student_id) DO NOTHING RETURNING id`,
      [eventId, studentId]
    );
    if (!ins.rowCount) return fail('ALREADY_WAITLISTED');
    const pos = await c.query('SELECT count(*)::int AS n FROM waitlist WHERE event_id=$1 AND id <= $2', [
      eventId,
      ins.rows[0].id,
    ]);
    return { ok: true, position: pos.rows[0].n };
  });
}

async function leaveWaitlist(eventId, studentId) {
  const r = await pool.query('DELETE FROM waitlist WHERE event_id=$1 AND student_id=$2', [eventId, studentId]);
  return r.rowCount > 0 ? { ok: true } : fail('NOT_FOUND');
}

// Called inside the cancel transaction (event row already locked).
// Hands the freed seat to the first eligible waiter; returns null if nobody qualifies.
async function promoteFromWaitlist(client, eventId) {
  let lastId = 0;
  for (;;) {
    const w = await client.query(
      `SELECT id, student_id FROM waitlist WHERE event_id=$1 AND id > $2 ORDER BY id LIMIT 1 FOR UPDATE`,
      [eventId, lastId]
    );
    if (!w.rowCount) return null;
    const { id, student_id } = w.rows[0];
    lastId = Number(id);

    if (await hasActiveBooking(client, eventId, student_id)) {
      await client.query('DELETE FROM waitlist WHERE id=$1', [id]); // stale entry
      continue;
    }
    if (await studentAtLimit(client, student_id)) continue; // keeps their place, skipped for now

    await client.query('DELETE FROM waitlist WHERE id=$1', [id]);
    const ra = await client.query('SELECT requires_approval FROM events WHERE id=$1', [eventId]);
    const bookingId = await insertBooking(client, eventId, student_id, ra.rows[0].requires_approval ? 'pending' : 'confirmed');
    return { bookingId, studentId: String(student_id) };
  }
}

// ---------- cancel ----------
// actor = { id, role }. Students cancel their own; an organizer cancels bookings of their own events.
async function cancelBooking(bookingId, actor) {
  const pre = await pool.query(
    `SELECT b.event_id, b.student_id, e.organizer_id
       FROM bookings b JOIN events e ON e.id = b.event_id WHERE b.id=$1`,
    [bookingId]
  );
  if (!pre.rowCount) return fail('NOT_FOUND');
  const { event_id, student_id, organizer_id } = pre.rows[0];
  const isOwner = String(student_id) === String(actor.id);
  const isEventOrganizer = actor.role === 'organizer' && String(organizer_id) === String(actor.id);
  if (!isOwner && !isEventOrganizer) return fail('FORBIDDEN');

  return withTx(async (c) => {
    const ev = await c.query('SELECT status FROM events WHERE id=$1 FOR UPDATE', [event_id]); // 1. event
    const b = await c.query('SELECT status FROM bookings WHERE id=$1 FOR UPDATE', [bookingId]); // 2. booking
    if (!['pending', 'confirmed'].includes(b.rows[0].status)) return fail('INVALID_STATE');

    await c.query(`UPDATE bookings SET status='cancelled', cancelled_at=now() WHERE id=$1`, [bookingId]);

    // The freed seat goes straight to the waitlist (net seats_left unchanged) or back to the pool.
    const promoted = ev.rows[0].status === 'open' ? await promoteFromWaitlist(c, event_id) : null;
    if (!promoted) await c.query('UPDATE events SET seats_left = seats_left + 1 WHERE id=$1', [event_id]);
    return { ok: true, promoted };
  });
}

// ---------- organizer overrides ----------
// Both take the event row lock first, like every other write, so they cannot race
// with students booking or cancelling.

// Change an event's capacity. Cannot drop below the seats already taken.
// Extra seats go to the waitlist first (FIFO); the rest return to the pool.
async function setCapacity(eventId, organizerId, newTotal) {
  return withTx(async (c) => {
    const ev = await c.query('SELECT organizer_id, status FROM events WHERE id=$1 FOR UPDATE', [eventId]);
    if (!ev.rowCount || String(ev.rows[0].organizer_id) !== String(organizerId)) return fail('NOT_FOUND');
    const act = await c.query(
      `SELECT count(*)::int AS n FROM bookings WHERE event_id=$1 AND status IN ('pending','confirmed','checked_in')`,
      [eventId]
    );
    const taken = act.rows[0].n;
    if (newTotal < taken) return fail('CAPACITY_BELOW_BOOKED');

    let free = newTotal - taken;
    await c.query('UPDATE events SET total_seats=$1, seats_left=$2 WHERE id=$3', [newTotal, free, eventId]);

    let promoted = 0;
    if (ev.rows[0].status === 'open') {
      while (free > 0) {
        const p = await promoteFromWaitlist(c, eventId);
        if (!p) break;
        free -= 1;
        promoted += 1;
      }
      await c.query('UPDATE events SET seats_left=$1 WHERE id=$2', [free, eventId]);
    }
    return { ok: true, total_seats: newTotal, seats_left: free, promoted };
  });
}

// Organizer books a seat for a student by email. Allowed even when bookings are closed
// and past the per-student limit, but never beyond capacity (raise the capacity first).
async function organizerBook(eventId, organizerId, studentEmail) {
  try {
    return await withTx(async (c) => {
      const ev = await c.query('SELECT organizer_id, seats_left FROM events WHERE id=$1 FOR UPDATE', [eventId]);
      if (!ev.rowCount || String(ev.rows[0].organizer_id) !== String(organizerId)) return fail('NOT_FOUND');
      const st = await c.query(`SELECT id FROM users WHERE email=$1 AND role='student'`, [studentEmail]);
      if (!st.rowCount) return fail('STUDENT_NOT_FOUND');
      const studentId = st.rows[0].id;
      if (await hasActiveBooking(c, eventId, studentId)) return fail('ALREADY_BOOKED');
      if (ev.rows[0].seats_left <= 0) return fail('SOLD_OUT');

      await c.query('DELETE FROM waitlist WHERE event_id=$1 AND student_id=$2', [eventId, studentId]);
      const bookingId = await insertBooking(c, eventId, studentId);
      await c.query('UPDATE events SET seats_left = seats_left - 1 WHERE id=$1', [eventId]);
      return { ok: true, bookingId };
    });
  } catch (e) {
    return mapDuplicate(e);
  }
}

// ---------- delete an event ----------
// Under the event lock so nothing can book it while it is being removed.
// Removes its waitlist and bookings too. Only the event's own organizer may do this.
async function deleteEvent(eventId, organizerId) {
  return withTx(async (c) => {
    const ev = await c.query('SELECT organizer_id FROM events WHERE id=$1 FOR UPDATE', [eventId]);
    if (!ev.rowCount || String(ev.rows[0].organizer_id) !== String(organizerId)) return fail('NOT_FOUND');
    const b = await c.query('DELETE FROM bookings WHERE event_id=$1', [eventId]);
    await c.query('DELETE FROM waitlist WHERE event_id=$1', [eventId]);
    await c.query('DELETE FROM events WHERE id=$1', [eventId]);
    return { ok: true, removed_bookings: b.rowCount };
  });
}

// ---------- organizer approval ----------
// A pending booking already holds its seat, so approving never changes seats_left.
async function approveBooking(bookingId, organizerId) {
  const pre = await pool.query(
    `SELECT b.event_id FROM bookings b JOIN events e ON e.id=b.event_id WHERE b.id=$1 AND e.organizer_id=$2`,
    [bookingId, organizerId]
  );
  if (!pre.rowCount) return fail('NOT_FOUND');
  return withTx(async (c) => {
    await c.query('SELECT id FROM events WHERE id=$1 FOR UPDATE', [pre.rows[0].event_id]);
    const upd = await c.query(`UPDATE bookings SET status='confirmed' WHERE id=$1 AND status='pending' RETURNING id`, [bookingId]);
    return upd.rowCount ? { ok: true } : fail('INVALID_STATE');
  });
}

// ---------- event settings ----------
async function updateSettings(eventId, organizerId, { lock_mode, requires_approval }) {
  const r = await pool.query(
    `UPDATE events SET lock_mode = COALESCE($1, lock_mode), requires_approval = COALESCE($2, requires_approval)
      WHERE id=$3 AND organizer_id=$4 RETURNING id, lock_mode, requires_approval`,
    [lock_mode ?? null, requires_approval ?? null, eventId, organizerId]
  );
  return r.rowCount ? { ok: true, event: r.rows[0] } : fail('NOT_FOUND');
}

module.exports = {
  bookSeatWithRowLock,
  bookSeatWithAtomicUpdate,
  bookSeatNaive,
  joinWaitlist,
  leaveWaitlist,
  cancelBooking,
  setCapacity,
  organizerBook,
  approveBooking,
  deleteEvent,
  updateSettings,
  makeQrToken,
  verifyQrToken,
};