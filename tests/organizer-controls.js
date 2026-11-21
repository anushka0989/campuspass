// Organizer controls: seat overrides, per-event locking mode, booking approval.
const h = require('./helpers');

h.run('Organizer controls: overrides, lock mode, approval', async (t) => {
  const org = await h.orgLogin();
  const [A, B, C, D] = await h.students('octl', 4);
  const created = [];
  const mk = async (opts) => { const id = await h.createEvent(org, opts); created.push(id); return id; };
  const patch = (path, body, cookie = org) => h.http('PATCH', path, { cookie, body });
  const post = (path, body, cookie = org) => h.http('POST', path, { cookie, body });
  const code = (r) => r.data && r.data.error && r.data.error.code;

  try {
    // ---------- 1. seat overrides ----------
    const e1 = await mk({ seats: 2, title: 'override' });
    t.check('force-book a student by email', (await post(`/api/events/${e1}/bookings`, { email: A.email })).status === 201);
    t.check('force-book same student twice is ALREADY_BOOKED', code(await post(`/api/events/${e1}/bookings`, { email: A.email })) === 'ALREADY_BOOKED');
    t.check('unknown email is STUDENT_NOT_FOUND', code(await post(`/api/events/${e1}/bookings`, { email: 'nobody@nowhere.local' })) === 'STUDENT_NOT_FOUND');
    await post(`/api/events/${e1}/bookings`, { email: B.email });
    t.check('force-book cannot exceed capacity (SOLD_OUT)', code(await post(`/api/events/${e1}/bookings`, { email: C.email })) === 'SOLD_OUT');
    t.check('waitlist join works when full', (await h.joinWaitlist(e1, C.cookie)).status === 201);
    t.check('capacity cannot drop below booked seats', code(await patch(`/api/events/${e1}/capacity`, { total_seats: 1 })) === 'CAPACITY_BELOW_BOOKED');
    const up = await patch(`/api/events/${e1}/capacity`, { total_seats: 4 });
    t.check('raising capacity promotes the waitlist and frees the rest', up.status === 200 && up.data.promoted === 1 && up.data.seats_left === 1, JSON.stringify(up.data));
    t.check('counter and rows reconcile after overrides', (await h.reconcile(e1)).ok === true);
    t.check('students cannot change capacity (403)', (await patch(`/api/events/${e1}/capacity`, { total_seats: 9 }, A.cookie)).status === 403);
    t.check('students cannot force-book (403)', (await post(`/api/events/${e1}/bookings`, { email: D.email }, A.cookie)).status === 403);
    t.check('bad seat count is a 400', (await patch(`/api/events/${e1}/capacity`, { total_seats: 'x' })).status === 400);

    // ---------- 2. locking mode per event ----------
    const e2 = await mk({ seats: 1, title: 'lockmode' });
    t.check('invalid lock mode is a 400', (await patch(`/api/events/${e2}/settings`, { lock_mode: 'banana' })).status === 400);
    t.check('switch event to atomic mode', (await patch(`/api/events/${e2}/settings`, { lock_mode: 'atomic' })).data.event.lock_mode === 'atomic');
    const racers = [A, B, C, D];
    const rs = await Promise.all(racers.map((s) => h.book(e2, s.cookie)));
    t.check('atomic mode: exactly 1 of 4 wins, rest 409, no 5xx', rs.filter((x) => x.status === 201).length === 1 && rs.filter((x) => x.status === 409).length === 3);
    t.check('atomic mode reconciles', (await h.reconcile(e2)).ok === true);
    t.check('students cannot change settings (403)', (await patch(`/api/events/${e2}/settings`, { lock_mode: 'rowlock' }, A.cookie)).status === 403);

    // ---------- 3. approval ----------
    const e3 = await h.createEvent(org, { seats: 2, title: 'approval' }); created.push(e3);
    await patch(`/api/events/${e3}/settings`, { requires_approval: true });
    const b1 = await h.book(e3, A.cookie);
    t.check('booking with approval on returns pending', b1.status === 201 && b1.data.booking.status === 'pending', JSON.stringify(b1.data));
    t.check('a pending booking already holds its seat', (await h.reconcile(e3)).seats_left === 1);
    t.check('pending booking has no QR image yet', (await h.http('GET', `/api/bookings/${b1.data.booking.bookingId}/qr`, { cookie: A.cookie })).status === 404);
    t.check('students cannot approve (403)', (await post(`/api/bookings/${b1.data.booking.bookingId}/approve`, {}, A.cookie)).status === 403);
    t.check('organizer approves it', (await post(`/api/bookings/${b1.data.booking.bookingId}/approve`, {})).status === 200);
    t.check('approving twice is refused', (await post(`/api/bookings/${b1.data.booking.bookingId}/approve`, {})).status === 409);
    t.check('approved booking has a QR image', (await h.http('GET', `/api/bookings/${b1.data.booking.bookingId}/qr`, { cookie: A.cookie })).status === 200);
    t.check('seats unchanged by approval', (await h.reconcile(e3)).seats_left === 1);

    const b2 = await h.book(e3, B.cookie);
    t.check('second booking pending, event now full', b2.status === 201 && (await h.reconcile(e3)).seats_left === 0);
    t.check('waitlist join while full', (await h.joinWaitlist(e3, C.cookie)).status === 201);
    t.check('organizer rejects (cancels) the pending booking', (await h.http('DELETE', `/api/bookings/${b2.data.booking.bookingId}`, { cookie: org })).status === 200);
    const mineC = (await h.myBookings(C.cookie)).find((x) => String(x.event_id) === String(e3));
    t.check('rejection promotes the waitlist, and the promoted booking is pending too', mineC && mineC.status === 'pending', JSON.stringify(mineC));
    t.check('counter and rows reconcile with pending bookings', (await h.reconcile(e3)).ok === true);

    // pending counts toward the per-student limit / duplicate rule
    t.check('student cannot book again while pending', code(await h.book(e3, C.cookie)) === 'ALREADY_BOOKED');
  } finally {
    await h.cleanupEvents(created);
  }
});
