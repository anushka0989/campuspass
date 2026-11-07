import express from 'express';
import 'dotenv/config';
import { pool } from './db.js';

const app = express();
app.use(express.json());

app.get('/health', (req, res) => res.json({ ok: true }));

// NAIVE: check, then write as separate steps. This is the bug.
app.post('/events/:id/book', async (req, res) => {
  try {
    const eventId = Number(req.params.id);
    const userId = Number(req.body.userId);

    const { rows: [ev] } = await pool.query(
      'SELECT seats_left FROM events WHERE id = $1', [eventId]);
    if (!ev) return res.status(404).json({ error: 'NOT_FOUND' });
    if (ev.seats_left <= 0) return res.status(409).json({ error: 'SOLD_OUT' });

    await pool.query(
      'INSERT INTO bookings (event_id, user_id) VALUES ($1, $2)', [eventId, userId]);
    await pool.query(
      'UPDATE events SET seats_left = seats_left - 1 WHERE id = $1', [eventId]);

    res.status(201).json({ status: 'confirmed' });
  } catch (e) {
    console.error(e.message);
    res.status(500).json({ error: 'SERVER_ERROR' });
  }
});

// maps database errors to HTTP responses
function sendError(res, e) {
  if (e.code === '23505') return res.status(409).json({ error: 'ALREADY_BOOKED' });
  if (e.code === '23503') return res.status(404).json({ error: 'NOT_FOUND' });
  console.error(e.message);
  return res.status(500).json({ error: 'SERVER_ERROR' });
}

// OPTION A: atomic conditional update inside a transaction
app.post('/events/:id/book-atomic', async (req, res) => {
  const eventId = Number(req.params.id);
  const userId = Number(req.body.userId);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const upd = await client.query(
      `UPDATE events SET seats_left = seats_left - 1
       WHERE id = $1 AND status = 'open' AND seats_left > 0
       RETURNING seats_left`, [eventId]);

    if (upd.rowCount === 0) {
      await client.query('ROLLBACK');
      // use the same client here: asking the pool for a second one can deadlock it
      const { rows: [ev] } = await client.query(
        'SELECT status FROM events WHERE id = $1', [eventId]);
      if (!ev) return res.status(404).json({ error: 'NOT_FOUND' });
      if (ev.status !== 'open') return res.status(422).json({ error: 'BOOKINGS_CLOSED' });
      return res.status(409).json({ error: 'SOLD_OUT' });
    }

    await client.query(
      'INSERT INTO bookings (event_id, user_id) VALUES ($1, $2)', [eventId, userId]);
    await client.query('COMMIT');
    res.status(201).json({ status: 'confirmed' });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    sendError(res, e);
  } finally {
    client.release();
  }
});

// OPTION B: row lock with SELECT ... FOR UPDATE
app.post('/events/:id/book-lock', async (req, res) => {
  const eventId = Number(req.params.id);
  const userId = Number(req.body.userId);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [ev] } = await client.query(
      'SELECT status, seats_left FROM events WHERE id = $1 FOR UPDATE', [eventId]);

    if (!ev) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'NOT_FOUND' });
    }
    if (ev.status !== 'open') {
      await client.query('ROLLBACK');
      return res.status(422).json({ error: 'BOOKINGS_CLOSED' });
    }
    if (ev.seats_left <= 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'SOLD_OUT' });
    }

    await client.query(
      'INSERT INTO bookings (event_id, user_id) VALUES ($1, $2)', [eventId, userId]);
    await client.query(
      'UPDATE events SET seats_left = seats_left - 1 WHERE id = $1', [eventId]);
    await client.query('COMMIT');
    res.status(201).json({ status: 'confirmed' });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    sendError(res, e);
  } finally {
    client.release();
  }
});

app.listen(process.env.PORT, () => console.log('listening on', process.env.PORT));