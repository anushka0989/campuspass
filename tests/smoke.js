// Smoke test.
//   1. 1 seat, 2 different students at once: exactly one wins.
//   2. ONE student double-clicking: 5 simultaneous requests for the same event take only one seat.
const h = require('./helpers');

h.run('Smoke test: last seat + duplicate booking', async (t) => {
  const org = await h.orgLogin();
  const [a, b, c] = await h.students('smoke', 3);
  const created = [];
  const mk = async (opts) => { const id = await h.createEvent(org, opts); created.push(id); return id; };

  try {
    // ---- 1 seat, 2 concurrent students ----
    const eventId = await mk({ seats: 1, title: 'smoke' });
    const results = await Promise.all([h.book(eventId, a.cookie), h.book(eventId, b.cookie)]);
    const statuses = results.map((r) => r.status).sort();
    console.log(`  1 seat, 2 requests -> ${statuses.join(', ')}`);

    const dash = await h.dashboard(eventId, org);
    const confirmed = dash.bookings.filter((x) => x.status === 'confirmed');
    const rec = await h.reconcile(eventId);

    t.check('one 201 and one 409', statuses[0] === 201 && statuses[1] === 409, statuses.join(','));
    t.check('seats_left = 0', dash.event.seats_left === 0, `seats_left=${dash.event.seats_left}`);
    t.check('exactly 1 confirmed booking', confirmed.length === 1, `confirmed=${confirmed.length}`);
    t.check('seats_left + bookings = capacity', rec.ok, JSON.stringify(rec));
    const loser = results.find((r) => r.status === 409);
    t.check('loser gets SOLD_OUT', loser?.data?.error?.code === 'SOLD_OUT', JSON.stringify(loser?.data));

    // ---- one student, many simultaneous clicks, both mechanisms ----
    for (const strategy of ['rowlock', 'atomic']) {
      const ev = await mk({ seats: 5, title: `duplicate-${strategy}` });
      const rs = await Promise.all(Array.from({ length: 5 }, () => h.book(ev, c.cookie, strategy)));
      const won = rs.filter((r) => r.status === 201).length;
      const dup = rs.filter((r) => r.status === 409 && r.data.error.code === 'ALREADY_BOOKED').length;
      const r2 = await h.reconcile(ev);
      t.check(`[${strategy}] 5 clicks by one student: exactly 1 seat taken`, won === 1 && r2.active_bookings === 1, `won ${won}, rows ${r2.active_bookings}`);
      t.check(`[${strategy}] the other 4 get 409 ALREADY_BOOKED (no 5xx)`, dup === 4, rs.map((r) => r.status).join(','));
      t.check(`[${strategy}] seats_left is 4 and the counters reconcile`, r2.seats_left === 4 && r2.ok, JSON.stringify(r2));
    }
  } finally {
    await h.cleanupEvents(created);
  }
});
