// Database-wide invariants, checked against ground truth after everything else has run.
const h = require('./helpers');

h.run('Database invariants (all events)', async (t) => {
  const q = (sql) => h.db().query(sql).then((r) => r.rows);

  const drift = await q('SELECT id, total_seats, seats_left, active_bookings FROM event_reconciliation WHERE NOT ok');
  t.check('seats_left + active bookings = capacity for every event', drift.length === 0, JSON.stringify(drift.slice(0, 3)));

  const negative = await q('SELECT id FROM events WHERE seats_left < 0 OR seats_left > total_seats');
  t.check('no event has negative or excess seats', negative.length === 0, JSON.stringify(negative));

  const dupes = await q(`SELECT event_id, student_id FROM bookings WHERE status IN ('pending','confirmed','checked_in') GROUP BY 1,2 HAVING count(*) > 1`);
  t.check('no student holds two active seats for one event', dupes.length === 0, JSON.stringify(dupes));

  const stale = await q(`SELECT w.id FROM waitlist w JOIN bookings b ON b.event_id=w.event_id AND b.student_id=w.student_id AND b.status IN ('pending','confirmed','checked_in')`);
  t.check('nobody is both seated and waitlisted for the same event', stale.length === 0, JSON.stringify(stale));

  const unsigned = await q(`SELECT id FROM bookings WHERE status='confirmed' AND qr_token IS NULL`);
  t.check('every confirmed booking has a QR token', unsigned.length === 0, JSON.stringify(unsigned));
});