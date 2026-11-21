// Cancel-vs-book race, repeated. For each round:
//   A holds the only seat, B is first on the waitlist, C is not on the waitlist.
//   A cancels while B and C both try to book at the same moment.
// The freed seat must go to B (waitlist priority), exactly once, and C must never sneak in.
const h = require('./helpers');

const ROUNDS = Number(process.env.RACE_ROUNDS) || 25;

h.run(`Cancel-vs-book race, ${ROUNDS} rounds`, async (t) => {
  const org = await h.orgLogin();
  const [A, B, C] = await h.students('race', 3);
  let bad = 0;
  const problems = new Set();

  for (let round = 1; round <= ROUNDS; round++) {
    const eventId = await h.createEvent(org, { seats: 1, title: `race-${round}` });
    try {
      const first = await h.book(eventId, A.cookie);
      const bookingId = first.data?.booking?.bookingId;
      const wl = await h.joinWaitlist(eventId, B.cookie);
      if (first.status !== 201 || wl.status !== 201 || wl.data.position !== 1) {
        problems.add(`setup failed in round ${round}: book ${first.status}, waitlist ${wl.status}`);
        bad++;
        continue;
      }

      const [cancelRes, bBook, cBook] = await Promise.all([
        h.cancel(bookingId, A.cookie),
        h.book(eventId, B.cookie),
        h.book(eventId, C.cookie),
      ]);

      const [aList, bList, cList] = await Promise.all([A, B, C].map((s) => h.myBookings(s.cookie)));
      const forEvent = (list) => list.filter((x) => String(x.event_id) === String(eventId));
      const bActive = forEvent(bList).filter((x) => x.status === 'confirmed');
      const cAny = forEvent(cList).filter((x) => x.status === 'confirmed');
      const aActive = forEvent(aList).filter((x) => x.status === 'confirmed');
      const rec = await h.reconcile(eventId);
      const wlLeft = (await h.db().query('SELECT count(*)::int AS n FROM waitlist WHERE event_id=$1', [eventId])).rows[0].n;

      const issues = [];
      if (cancelRes.status !== 200) issues.push(`cancel returned ${cancelRes.status}`);
      if (bBook.status === 201 || cBook.status === 201) issues.push(`a direct booking got 201 (B ${bBook.status}, C ${cBook.status})`);
      if (bBook.status >= 500 || cBook.status >= 500) issues.push('a request returned 5xx');
      if (bActive.length !== 1) issues.push(`B holds ${bActive.length} seats, expected 1`);
      if (cAny.length !== 0) issues.push('C took the seat from the waitlist');
      if (aActive.length !== 0) issues.push('A still holds a seat');
      if (rec.seats_left !== 0 || rec.active_bookings !== 1 || !rec.ok) issues.push(`counters wrong: ${JSON.stringify(rec)}`);
      if (wlLeft !== 0) issues.push(`waitlist not empty (${wlLeft})`);

      if (issues.length) { bad++; issues.forEach((i) => problems.add(i)); }
    } finally {
      await h.cleanupEvents([eventId]);
    }
  }

  console.log(`  rounds clean: ${ROUNDS - bad}/${ROUNDS}`);
  [...problems].forEach((p) => console.log(`   - ${p}`));
  t.check(`all ${ROUNDS} rounds: waitlist head gets the seat, nobody oversells, counters reconcile`, bad === 0, `${bad} bad rounds`);
});
