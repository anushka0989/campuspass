// Authentication, authorization and input validation. Nothing here may ever produce a 5xx.
// Cross-organizer checks need ORGANIZER_CODE (the server and this script must share it).
const h = require('./helpers');

h.run('Auth, permissions and input validation', async (t) => {
  const org = await h.orgLogin();
  const [A, B] = await h.students('authz', 2);
  const stamp = Date.now();
  const created = [];
  const eventId = await h.createEvent(org, { seats: 2, title: 'authz' });
  created.push(eventId);

  try {
    // ---- anonymous ----
    t.check('anonymous booking is 401', (await h.book(eventId)).status === 401);
    t.check('anonymous dashboard is 401', (await h.http('GET', `/api/events/${eventId}/dashboard`)).status === 401);

    // ---- roles ----
    let r = await h.http('POST', '/api/events', { cookie: A.cookie, body: { title: 'x', starts_at: new Date(Date.now() + 1e8).toISOString(), total_seats: 5 } });
    t.check('a student cannot create events (403)', r.status === 403, String(r.status));
    t.check('a student cannot open the organizer dashboard (403)', (await h.http('GET', `/api/events/${eventId}/dashboard`, { cookie: A.cookie })).status === 403);
    t.check('an organizer cannot book seats (403)', (await h.book(eventId, org)).status === 403);

    // ---- organizer sign-up is gated ----
    r = await h.http('POST', '/api/auth/register', { body: { email: `authz_noinvite_${stamp}@loadtest.local`, password: 'password123', role: 'organizer' } });
    t.check('organizer sign-up without an invite code is 403', r.status === 403, String(r.status));
    r = await h.http('POST', '/api/auth/register', { body: { email: `authz_badcode_${stamp}@loadtest.local`, password: 'password123', role: 'organizer', inviteCode: 'wrong-code' } });
    t.check('organizer sign-up with a wrong code is 403', r.status === 403, String(r.status));

    // ---- registration + login validation ----
    r = await h.http('POST', '/api/auth/register', { body: { email: 'not-an-email', password: 'password123', role: 'student' } });
    t.check('invalid email is 400', r.status === 400, String(r.status));
    r = await h.http('POST', '/api/auth/register', { body: { email: `authz_short_${stamp}@loadtest.local`, password: 'short', role: 'student' } });
    t.check('short password is 400', r.status === 400, String(r.status));
    r = await h.http('POST', '/api/auth/register', { body: { email: A.email, password: 'password123', role: 'student' } });
    t.check('duplicate email is 409 EMAIL_TAKEN', r.status === 409 && r.data.error.code === 'EMAIL_TAKEN', JSON.stringify(r.data));

    const victim = `authz_brute_${stamp}@loadtest.local`;
    let last;
    for (let i = 0; i < 11; i++) last = await h.http('POST', '/api/auth/login', { body: { email: victim, password: 'wrong-password' } });
    t.check('11 failed logins in a row are rate limited (429)', last.status === 429, String(last.status));

    // ---- input validation: never a 500 ----
    t.check('non-numeric event id is 400', (await h.http('POST', '/api/events/abc/book', { cookie: A.cookie })).status === 400);
    t.check('SQL-ish event id is 400', (await h.http('POST', "/api/events/1;DROP/book", { cookie: A.cookie })).status === 400);
    const bad = (body) => h.http('POST', '/api/events', { cookie: org, body });
    const future = new Date(Date.now() + 1e8).toISOString();
    t.check('negative seats is 400', (await bad({ title: 'x', starts_at: future, total_seats: -5 })).status === 400);
    t.check('non-numeric seats is 400', (await bad({ title: 'x', starts_at: future, total_seats: 'abc' })).status === 400);
    t.check('fractional seats is 400', (await bad({ title: 'x', starts_at: future, total_seats: 2.5 })).status === 400);
    t.check('missing title is 400', (await bad({ starts_at: future, total_seats: 5 })).status === 400);
    t.check('past start time is 400', (await bad({ title: 'x', starts_at: '2001-01-01T00:00:00Z', total_seats: 5 })).status === 400);
    t.check('garbage date is 400', (await bad({ title: 'x', starts_at: 'tomorrow-ish', total_seats: 5 })).status === 400);
    const rawBad = await fetch(`${h.BASE}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{not json' });
    await rawBad.text();
    t.check('malformed JSON is 400', rawBad.status === 400, String(rawBad.status));
    const unknown = await h.http('GET', '/api/nope');
    t.check('unknown API route is a JSON 404', unknown.status === 404 && unknown.data?.error?.code === 'NOT_FOUND');

    // ---- ownership ----
    await h.book(eventId, A.cookie);
    const ticket = (await h.myBookings(A.cookie)).find((x) => String(x.event_id) === String(eventId));
    r = await h.cancel(ticket.id, B.cookie);
    t.check("a student cannot cancel someone else's booking (403)", r.status === 403, String(r.status));
    r = await h.cancel(999999999, A.cookie);
    t.check('cancelling a booking that does not exist is 404', r.status === 404, String(r.status));

    // ---- a second organizer must not touch the first one's event ----
    const code = process.env.ORGANIZER_CODE;
    if (!code) {
      console.log('  skip cross-organizer checks (set ORGANIZER_CODE to the server\'s code to run them)');
    } else {
      const email = `authz_org2_${stamp}@loadtest.local`;
      r = await h.http('POST', '/api/auth/register', { body: { email, password: 'password123', role: 'organizer', inviteCode: code } });
      t.check('organizer sign-up with the right code works (201)', r.status === 201 && r.data.user.role === 'organizer', JSON.stringify(r.data));
      const org2 = r.cookie;
      t.check("another organizer cannot read the event's dashboard (404)", (await h.http('GET', `/api/events/${eventId}/dashboard`, { cookie: org2 })).status === 404);
      t.check("another organizer cannot close the event (404)", (await h.http('PATCH', `/api/events/${eventId}/status`, { cookie: org2, body: { status: 'closed' } })).status === 404);
      t.check("another organizer cannot cancel the event's bookings (403)", (await h.cancel(ticket.id, org2)).status === 403);
      r = await h.http('POST', `/api/checkin/${ticket.qr_token}`, { cookie: org2 });
      t.check("another organizer cannot check in the event's tickets (403)", r.status === 403, String(r.status));
      const mine = await h.http('GET', '/api/organizer/events', { cookie: org2 });
      t.check("another organizer's list does not include this event", !mine.data.events.some((e) => String(e.id) === String(eventId)));
    }

    // the real organizer can cancel on a student's behalf
    r = await h.cancel(ticket.id, org);
    t.check("the event's organizer can cancel a booking (200)", r.status === 200, String(r.status));

    // ---- draft visibility ----
    const draft = await h.createEvent(org, { seats: 3, title: 'authz-draft', status: 'draft' });
    created.push(draft);
    const list = await h.http('GET', '/api/events');
    t.check('draft events are hidden from the public list', !list.data.events.some((e) => String(e.id) === String(draft)));
    r = await h.book(draft, A.cookie);
    t.check('a draft event cannot be booked (404)', r.status === 404, String(r.status));
    await h.http('PATCH', `/api/events/${draft}/status`, { cookie: org, body: { status: 'open' } });
    t.check('once published it can be booked', (await h.book(draft, A.cookie)).status === 201);

    // ---- closed events ----
    await h.http('PATCH', `/api/events/${draft}/status`, { cookie: org, body: { status: 'closed' } });
    r = await h.book(draft, B.cookie);
    t.check('a closed event refuses bookings (422 BOOKINGS_CLOSED)', r.status === 422 && r.data.error.code === 'BOOKINGS_CLOSED', JSON.stringify(r.data));
  } finally {
    await h.cleanupEvents(created);
  }
});
