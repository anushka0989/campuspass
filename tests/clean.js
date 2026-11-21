// Removes everything the test suite creates: "[test]" events and @loadtest.local students.
const h = require('./helpers');

h.run('Clean up test data', async (t) => {
  const pool = h.db();
  const ev = await pool.query(`SELECT id FROM events WHERE title LIKE '[test]%'`);
  await h.cleanupEvents(ev.rows.map((r) => r.id));
  await pool.query(`DELETE FROM waitlist WHERE student_id IN (SELECT id FROM users WHERE email LIKE '%@loadtest.local')`);
  await pool.query(`DELETE FROM bookings WHERE student_id IN (SELECT id FROM users WHERE email LIKE '%@loadtest.local')`);
  const owned = await pool.query(`SELECT id FROM events WHERE organizer_id IN (SELECT id FROM users WHERE email LIKE '%@loadtest.local')`);
  await h.cleanupEvents(owned.rows.map((r) => r.id));
  const users = await pool.query(`DELETE FROM users WHERE email LIKE '%@loadtest.local'`);
  console.log(`  removed ${ev.rowCount} test events and ${users.rowCount} test users`);
  t.check('test data removed', true);
});
