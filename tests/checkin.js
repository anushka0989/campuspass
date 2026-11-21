// QR check-in: HMAC verification, single use, organizer-only, and the QR image endpoint.
const h = require('./helpers');

h.run('QR check-in (HMAC)', async (t) => {
  const org = await h.orgLogin();
  const [A, B] = await h.students('checkin', 2);
  const eventId = await h.createEvent(org, { seats: 3, title: 'checkin' });

  try {
    await h.book(eventId, A.cookie);
    const ticket = (await h.myBookings(A.cookie)).find((x) => String(x.event_id) === String(eventId));
    t.check('booking returns a signed token', typeof ticket.qr_token === 'string' && ticket.qr_token.length > 40);

    // QR image
    const img = await fetch(`${h.BASE}/api/bookings/${ticket.id}/qr`, { headers: { Cookie: A.cookie } });
    const bytes = Buffer.from(await img.arrayBuffer());
    t.check('QR image endpoint returns a PNG', img.status === 200 && img.headers.get('content-type') === 'image/png' && bytes.slice(1, 4).toString() === 'PNG');
    const other = await fetch(`${h.BASE}/api/bookings/${ticket.id}/qr`, { headers: { Cookie: B.cookie } });
    await other.arrayBuffer();
    t.check("another student cannot fetch someone else's QR (404)", other.status === 404, String(other.status));

    // tampering
    const tampered = ticket.qr_token.slice(0, -2) + (ticket.qr_token.endsWith('AA') ? 'BB' : 'AA');
    let r = await h.http('POST', `/api/checkin/${tampered}`, { cookie: org });
    t.check('tampered token rejected (401 BAD_TOKEN)', r.status === 401 && r.data.error.code === 'BAD_TOKEN', JSON.stringify(r.data));
    r = await h.http('POST', '/api/checkin/not-a-token', { cookie: org });
    t.check('garbage token rejected (401)', r.status === 401, String(r.status));

    // only organizers
    r = await h.http('POST', `/api/checkin/${ticket.qr_token}`, { cookie: B.cookie });
    t.check('a student cannot check anyone in (403)', r.status === 403, String(r.status));
    r = await h.http('POST', `/api/checkin/${ticket.qr_token}`);
    t.check('anonymous cannot check in (401)', r.status === 401, String(r.status));

    // success, then single use
    r = await h.http('POST', `/api/checkin/${ticket.qr_token}`, { cookie: org });
    t.check('valid token checks the student in (200)', r.status === 200 && r.data.booking.email === A.email, JSON.stringify(r.data));
    r = await h.http('POST', `/api/checkin/${ticket.qr_token}`, { cookie: org });
    t.check('second scan is refused (409 ALREADY_CHECKED_IN)', r.status === 409 && r.data.error.code === 'ALREADY_CHECKED_IN', JSON.stringify(r.data));

    const dash = await h.dashboard(eventId, org);
    t.check('dashboard shows the booking as checked_in', dash.bookings.some((b) => b.status === 'checked_in'));

    r = await h.cancel(ticket.id, A.cookie);
    t.check('a checked-in ticket cannot be cancelled (409)', r.status === 409, String(r.status));

    // cancelled tickets cannot enter
    await h.book(eventId, B.cookie);
    const bTicket = (await h.myBookings(B.cookie)).find((x) => String(x.event_id) === String(eventId) && x.status === 'confirmed');
    await h.cancel(bTicket.id, B.cookie);
    r = await h.http('POST', `/api/checkin/${bTicket.qr_token}`, { cookie: org });
    t.check('a cancelled ticket cannot check in (409 CANCELLED)', r.status === 409 && r.data.error.code === 'CANCELLED', JSON.stringify(r.data));

    const rec = await h.reconcile(eventId);
    t.check('event reconciles', rec.ok, JSON.stringify(rec));
  } finally {
    await h.cleanupEvents([eventId]);
  }
});
