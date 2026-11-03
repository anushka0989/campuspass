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

app.listen(process.env.PORT, () => console.log('listening on', process.env.PORT));