require('dotenv').config();
const bcrypt = require('bcryptjs');
const pool = require('../server/db');
const { makeQrToken } = require('../server/bookingService');

// Demo data. Safe to re-run: it replaces only the demo organizer's events.
const PASSWORD = 'password123';

function at(daysAhead, hour) {
  const d = new Date();
  d.setDate(d.getDate() + daysAhead);
  d.setHours(hour, 0, 0, 0);
  return d.toISOString();
}

(async () => {
  try {
    const hash = await bcrypt.hash(PASSWORD, 10);
    const upsert = (email, role) =>
      pool.query(
        `INSERT INTO users(email, password_hash, role) VALUES($1, $2, $3)
         ON CONFLICT(email) DO UPDATE SET password_hash=EXCLUDED.password_hash RETURNING id`,
        [email, hash, role]
      );

    const org = (await upsert('org@test.com', 'organizer')).rows[0].id;
    const [s1, s2] = [(await upsert('stu1@test.com', 'student')).rows[0].id, (await upsert('stu2@test.com', 'student')).rows[0].id];
    await upsert('stu3@test.com', 'student');

    // clear the demo organizer's previous events (foreign keys are RESTRICT, so children first)
    await pool.query('DELETE FROM waitlist WHERE event_id IN (SELECT id FROM events WHERE organizer_id=$1)', [org]);
    await pool.query('DELETE FROM bookings WHERE event_id IN (SELECT id FROM events WHERE organizer_id=$1)', [org]);
    await pool.query('DELETE FROM events WHERE organizer_id=$1', [org]);

    const addEvent = async ({ title, description, venue, days, hour, seats, left = seats, status = 'open' }) =>
      (
        await pool.query(
          `INSERT INTO events(organizer_id, title, description, venue, starts_at, total_seats, seats_left, status)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
          [org, title, description, venue, at(days, hour), seats, left, status]
        )
      ).rows[0].id;

    await addEvent({
      title: 'Intro to Generative AI',
      description: 'A guest talk on how language models are built, with a live Q&A.',
      venue: 'Auditorium A',
      days: 3, hour: 15, seats: 100,
    });
    await addEvent({
      title: 'Open Mic Night',
      description: 'Music, poetry and stand-up from students. Sign up on the night to perform.',
      venue: 'Student Centre Lawn',
      days: 5, hour: 18, seats: 60,
    });
    await addEvent({
      title: 'Last Seat Demo',
      description: 'One seat only. Book it from two accounts at once to watch the lock work.',
      venue: 'Seminar Room 2',
      days: 4, hour: 11, seats: 1,
    });

    // A sold-out workshop with both seats taken, so the waitlist can be demonstrated.
    const sold = await addEvent({
      title: 'Full-Stack Workshop',
      description: 'Hands-on session building a REST API with Express and PostgreSQL.',
      venue: 'Computer Lab 3',
      days: 2, hour: 10, seats: 2, left: 0,
    });
    for (const sid of [s1, s2]) {
      const b = await pool.query(`INSERT INTO bookings(event_id, student_id, status) VALUES($1,$2,'confirmed') RETURNING id`, [sold, sid]);
      await pool.query('UPDATE bookings SET qr_token=$1 WHERE id=$2', [makeQrToken(b.rows[0].id, sold), b.rows[0].id]);
    }

    await addEvent({
      title: 'Cultural Fest Registration',
      description: 'Registration for the annual cultural fest has been closed by the organizer.',
      venue: 'Main Quad',
      days: 10, hour: 9, seats: 200, status: 'closed',
    });
    await addEvent({
      title: 'Hackathon Kickoff',
      description: 'Draft: not visible to students until it is published.',
      venue: 'Innovation Hub',
      days: 14, hour: 9, seats: 150, status: 'draft',
    });

    console.log('Seeded demo data.');
    console.log(`Logins (password "${PASSWORD}"): org@test.com, stu1@test.com, stu2@test.com, stu3@test.com`);
  } catch (e) {
    console.error('Seeding failed:', e.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
