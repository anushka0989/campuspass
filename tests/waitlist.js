// Waitlist behaviour: validation, FIFO promotion, leaving, and cancel edge cases.
const h = require('./helpers');

h.run('Waitlist: validation, FIFO promotion, edge cases', async (t) => {
  const org = await h.orgLogin();
  const [A, B, C, D] = await h.students('wl', 4);
  const created = [];
  const mk = async (opts) => { const id = await h.createEvent(org, opts); created.push(id); return id; };
  const active = async (s, eventId) => (await h.myBookings(s.cookie)).filter((x) => String(x.event_id) === String(eventId) && x.status === 'confirmed');
  const position = async (s, eventId) => ((await h.http('GET', '/api/waitlist/mine', { cookie: s.cookie })).data.waitlist.find((w) => String(w.event_id) === String(eventId)) || {}).position;

  try {
    // ---- validation ----
    const open = await mk({ seats: 5, title: 'wl-open' });
    let r = await h.joinWaitlist(open, A.cookie);
    t.check('cannot join the waitlist while seats are available (409 SEATS_AVAILABLE)', r.status === 409 && r.data.error.code === 'SEATS_AVAILABLE', JSON.stringify(r.data));

    r = await h.joinWaitlist(999999999, A.cookie);
    t.check('joining a non-existent event is 404', r.status === 404, String(r.status));

    const draft = await mk({ seats: 1, title: 'wl-draft', status: 'draft' });
    r = await h.joinWaitlist(draft, A.cookie);
    t.check('joining a draft event is 404', r.status === 404, String(r.status));

    // ---- FIFO ----
    const ev = await mk({ seats: 1, title: 'wl-fifo' });
    const aBooking = (await h.book(ev, A.cookie)).data.booking.bookingId;

    r = await h.joinWaitlist(ev, A.cookie);
    t.check('a student holding a seat cannot join (409 ALREADY_BOOKED)', r.status === 409 && r.data.error.code === 'ALREADY_BOOKED', JSON.stringify(r.data));

    const joins = [];
    for (const s of [B, C, D]) joins.push((await h.joinWaitlist(ev, s.cookie)).data?.position);
    t.check('B, C, D join in order as positions 1, 2, 3', joins.join() === '1,2,3', joins.join());

    r = await h.joinWaitlist(ev, B.cookie);
    t.check('joining twice is 409 ALREADY_WAITLISTED', r.status === 409 && r.data.error.code === 'ALREADY_WAITLISTED', JSON.stringify(r.data));

    // C leaves; D moves up
    r = await h.http('DELETE', `/api/events/${ev}/waitlist`, { cookie: C.cookie });
    t.check('C can leave the waitlist', r.status === 200, String(r.status));
    t.check('D moves up to position 2', (await position(D, ev)) === 2);

    // A cancels -> B (head of the line) gets the seat
    r = await h.cancel(aBooking, A.cookie);
    t.check('A cancels (200, promoted)', r.status === 200 && r.data.promoted === true, JSON.stringify(r.data));
    t.check('B was promoted and now holds the seat', (await active(B, ev)).length === 1);
    t.check('D is now first on the waitlist', (await position(D, ev)) === 1);
    let rec = await h.reconcile(ev);
    t.check('seats_left 0, 1 active booking, reconciled', rec.seats_left === 0 && rec.active_bookings === 1 && rec.ok, JSON.stringify(rec));

    // cancel twice
    r = await h.cancel(aBooking, A.cookie);
    t.check('cancelling again is 409 INVALID_STATE', r.status === 409 && r.data.error.code === 'INVALID_STATE', JSON.stringify(r.data));

    // B cancels -> D promoted
    const bBooking = (await active(B, ev))[0].id;
    await h.cancel(bBooking, B.cookie);
    t.check('D promoted after B cancels', (await active(D, ev)).length === 1);

    // D cancels with an empty waitlist -> seat returns to the pool
    const dBooking = (await active(D, ev))[0].id;
    r = await h.cancel(dBooking, D.cookie);
    t.check('cancel with nobody waiting: not promoted', r.status === 200 && r.data.promoted === false, JSON.stringify(r.data));
    rec = await h.reconcile(ev);
    t.check('seat returned: seats_left 1, 0 active, reconciled', rec.seats_left === 1 && rec.active_bookings === 0 && rec.ok, JSON.stringify(rec));

    // a cancelled student can book again
    r = await h.book(ev, A.cookie);
    t.check('a student who cancelled can book again', r.status === 201, String(r.status));

    // ---- closed event: seat returns to the pool, no promotion ----
    const closedEv = await mk({ seats: 1, title: 'wl-closed' });
    const aClosed = (await h.book(closedEv, A.cookie)).data.booking.bookingId;
    await h.joinWaitlist(closedEv, B.cookie);
    await h.http('PATCH', `/api/events/${closedEv}/status`, { cookie: org, body: { status: 'closed' } });
    r = await h.cancel(aClosed, A.cookie);
    t.check('cancel on a closed event does not promote', r.status === 200 && r.data.promoted === false, JSON.stringify(r.data));
    t.check('B was not given a seat on a closed event', (await active(B, closedEv)).length === 0);
    rec = await h.reconcile(closedEv);
    t.check('closed event still reconciles', rec.ok && rec.seats_left === 1, JSON.stringify(rec));
  } finally {
    await h.cleanupEvents(created);
  }
});
