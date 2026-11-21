// Scale test: 100 seats, 500 concurrent booking requests from 500 different students.
//   node tests/scale.js rowlock | atomic   -> must PASS
//   node tests/scale.js naive              -> demonstrates the race; a "race detected" result is the expected outcome
const h = require('./helpers');

const strategy = process.argv[2] || 'rowlock';
const SEATS = 100;
const USERS = 500;

h.run(`Scale test [${strategy}]: ${SEATS} seats, ${USERS} concurrent requests`, async (t) => {
  const org = await h.orgLogin();
  const eventId = await h.createEvent(org, { seats: SEATS, title: `scale-${strategy}` });

  try {
    console.log(`  preparing ${USERS} students...`);
    const studs = await h.students('scale', USERS);

    console.log(`  firing ${USERS} requests at once...`);
    const r = await h.fireAll(eventId, studs.map((s) => s.cookie), strategy);

    const dash = await h.dashboard(eventId, org);
    const byStatus = {};
    for (const b of dash.bookings) byStatus[b.status] = (byStatus[b.status] || 0) + 1;
    const active = (byStatus.confirmed || 0) + (byStatus.checked_in || 0);
    const rec = await h.reconcile(eventId);

    console.log(`  responses:    ${JSON.stringify(r.tally)}`);
    console.log(`  booking rows: ${dash.bookings.length} (${JSON.stringify(byStatus)})`);
    console.log(`  seats_left:   ${dash.event.seats_left}`);
    console.log(`  throughput:   ${r.rps.toFixed(0)} req/s   p50 ${r.p50.toFixed(0)} ms   p95 ${r.p95.toFixed(0)} ms   total ${r.totalMs.toFixed(0)} ms`);

    const problems = [];
    if (r.tally[201] !== SEATS) problems.push(`expected exactly ${SEATS} x 201, got ${r.tally[201] || 0}`);
    if (r.tally[409] !== USERS - SEATS) problems.push(`expected exactly ${USERS - SEATS} x 409, got ${r.tally[409] || 0}`);
    const others = Object.keys(r.tally).filter((s) => s !== '201' && s !== '409');
    if (others.length) problems.push(`unexpected responses: ${others.map((s) => `${s} x ${r.tally[s]}`).join(', ')} (zero 500s allowed)`);
    if (dash.event.seats_left !== 0) problems.push(`seats_left is ${dash.event.seats_left}, expected 0`);
    if (active !== SEATS) problems.push(`${active} active booking rows, expected exactly ${SEATS}`);
    if (!rec.ok) problems.push(`counter and rows disagree: seats_left ${rec.seats_left} + bookings ${rec.active_bookings} != capacity ${rec.total_seats}`);

    if (strategy === 'naive') {
      console.log('');
      if (problems.length) {
        console.log('  RACE DETECTED (expected for the naive strategy). The test is able to catch overselling:');
        problems.forEach((p) => console.log(`   - ${p}`));
      } else {
        console.log('  The naive strategy got lucky this time - run it again. The race is timing dependent.');
      }
      return; // informational, never fails the suite
    }

    t.check(`exactly ${SEATS} responses of 201`, r.tally[201] === SEATS, `got ${r.tally[201] || 0}`);
    t.check(`exactly ${USERS - SEATS} responses of 409`, r.tally[409] === USERS - SEATS, `got ${r.tally[409] || 0}`);
    t.check('zero 500s / network errors', others.length === 0, JSON.stringify(r.tally));
    t.check('seats_left = 0 (never negative)', dash.event.seats_left === 0, `seats_left=${dash.event.seats_left}`);
    t.check(`exactly ${SEATS} active booking rows`, active === SEATS, `active=${active}`);
    t.check('seats_left + bookings = capacity', rec.ok, JSON.stringify(rec));
  } finally {
    await h.cleanupEvents([eventId]);
  }
});
