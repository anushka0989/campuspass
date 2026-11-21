// Per-student booking limit: a student may hold at most MAX upcoming confirmed bookings,
// even when they fire bookings for several events at the same instant.
const h = require('./helpers');

const LIMIT = Number(process.env.MAX_ACTIVE_BOOKINGS) || 3;

h.run(`Per-student booking limit (${LIMIT})`, async (t) => {
  const org = await h.orgLogin();
  const [seq, raceRowlock, raceAtomic] = await h.students('limit', 3);
  const created = [];
  const mk = async (n, title) => { const ids = []; for (let i = 0; i < n; i++) { const id = await h.createEvent(org, { seats: 5, title: `${title}-${i}` }); created.push(id); ids.push(id); } return ids; };

  try {
    // ---- sequential ----
    const evs = await mk(LIMIT + 2, 'limit-seq');
    const ok = [];
    for (let i = 0; i < LIMIT; i++) ok.push((await h.book(evs[i], seq.cookie)).status);
    t.check(`first ${LIMIT} bookings succeed`, ok.every((s) => s === 201), ok.join());

    let r = await h.book(evs[LIMIT], seq.cookie);
    t.check(`booking number ${LIMIT + 1} is refused (409 BOOKING_LIMIT_REACHED)`, r.status === 409 && r.data.error.code === 'BOOKING_LIMIT_REACHED', JSON.stringify(r.data));
    let rec = await h.reconcile(evs[LIMIT]);
    t.check('the refused booking did not consume a seat', rec.seats_left === 5 && rec.ok, JSON.stringify(rec));

    const first = (await h.myBookings(seq.cookie)).find((x) => String(x.event_id) === String(evs[0]));
    await h.cancel(first.id, seq.cookie);
    r = await h.book(evs[LIMIT], seq.cookie);
    t.check('cancelling one frees a slot', r.status === 201, String(r.status));

    // ---- concurrent: one student, many events at once ----
    for (const [student, strategy] of [[raceRowlock, 'rowlock'], [raceAtomic, 'atomic']]) {
      const racers = await mk(LIMIT + 3, `limit-race-${strategy}`);
      const results = await Promise.all(racers.map((id) => h.book(id, student.cookie, strategy)));
      const won = results.filter((x) => x.status === 201).length;
      const refused = results.filter((x) => x.status === 409 && x.data.error.code === 'BOOKING_LIMIT_REACHED').length;
      const recs = await Promise.all(racers.map((id) => h.reconcile(id)));
      t.check(`[${strategy}] ${racers.length} simultaneous bookings: exactly ${LIMIT} succeed`, won === LIMIT, `won ${won}`);
      t.check(`[${strategy}] the rest are refused with BOOKING_LIMIT_REACHED, no 5xx`, refused === racers.length - LIMIT, `refused ${refused}`);
      t.check(`[${strategy}] every event still reconciles`, recs.every((x) => x.ok));
    }
  } finally {
    await h.cleanupEvents(created);
  }
});
