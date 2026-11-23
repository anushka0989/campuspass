(async function () {
  const { $, esc, api, toast, date, renderNav } = CP;
  const user = await renderNav('organizer');
  if (!user || user.role !== 'organizer') { location.href = 'login.html'; return; }

  const listEl = $('#event-list');
  const panel = $('#panel');
  const emptyPanel = $('#panel-empty');
  const STATUS = { draft: ['Draft', 'chip-muted'], open: ['Open', 'chip-ok'], closed: ['Closed', 'chip-warn'] };
  const BOOKING = { pending: ['Awaiting approval', 'chip-warn'], confirmed: ['Confirmed', ''], checked_in: ['Checked in', 'chip-ok'], cancelled: ['Cancelled', 'chip-muted'] };
  const MAX_ROWS = 200;

  let selected = null;
  let events = [];
  let lastJson = '';
  let armed = null; // booking id waiting for a second click to confirm cancelling
  let pollTimer = null;

  // ---------- create event ----------
  const pad = (n) => String(n).padStart(2, '0');
  function defaultStart() {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    d.setHours(10, 0, 0, 0);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  $('#starts_at').value = defaultStart();

  $('#create-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    const err = $('#create-error');
    err.textContent = '';
    const publish = $('#publish').checked;
    try {
      const { event } = await api('/events', {
        method: 'POST',
        body: {
          title: $('#title').value,
          description: $('#description').value,
          venue: $('#venue').value,
          starts_at: new Date($('#starts_at').value).toISOString(),
          total_seats: Number($('#total_seats').value),
          status: publish ? 'open' : 'draft',
          lock_mode: $('#lock_mode').value,
          requires_approval: $('#requires_approval').checked,
        },
      });
      toast(publish ? 'Event published.' : 'Draft saved.');
      form.reset();
      $('#starts_at').value = defaultStart();
      $('#publish').checked = true;
      await loadEvents();
      select(event.id);
    } catch (ex) {
      err.textContent = ex.message;
    }
  });

  // ---------- event list ----------
  function renderList() {
    if (!events.length) {
      listEl.innerHTML = '<p class="muted">No events yet. Create your first one above.</p>';
      return;
    }
    listEl.innerHTML = events.map((ev) => {
      const [label, cls] = STATUS[ev.status];
      return `<button class="ev-item" type="button" data-id="${esc(ev.id)}" aria-pressed="${String(selected) === String(ev.id)}">
        <strong>${esc(ev.title)}</strong>
        <span class="sub"><span>${esc(date(ev.starts_at).full)}</span><span class="chip ${cls}">${label}</span></span>
        <span class="sub"><span>${esc(ev.booked)} of ${esc(ev.total_seats)} booked</span><span>${ev.waiting ? `${esc(ev.waiting)} waiting` : ''}</span></span>
      </button>`;
    }).join('');
  }

  async function loadEvents() {
    events = (await api('/organizer/events')).events;
    renderList();
  }

  listEl.addEventListener('click', (e) => {
    const b = e.target.closest('.ev-item');
    if (!b) return;
    select(b.dataset.id);
    // On a phone the dashboard sits below the list, so bring it into view.
    if (window.matchMedia('(max-width: 760px)').matches) panel.parentElement.scrollIntoView({ block: 'start' });
  });

  // ---------- live dashboard ----------
  const overrideEl = $('#override');
  const capInput = $('#cap-seats');

  function select(id) {
    if (typeof disarmDelete === 'function') disarmDelete();
    selected = id;
    overrideEl.hidden = false;
    const ev0 = events.find((x) => String(x.id) === String(id));
    if (ev0) { capInput.value = ev0.total_seats; }
    lastJson = '';
    armed = null;
    renderList();
    clearInterval(pollTimer);
    refreshPanel(true);
    pollTimer = setInterval(() => { if (!document.hidden) refreshPanel(false); }, 2000);
  }

  async function refreshPanel(force) {
    if (!selected) return;
    let data;
    try { data = await api(`/events/${selected}/dashboard`); } catch (err) { if (force) toast(err.message, 'error'); return; }
    const json = JSON.stringify(data) + String(armed);
    if (!force && json === lastJson) return;
    lastJson = json;
    renderPanel(data);
    loadEvents().catch(() => {});
  }

  function renderPanel({ event: ev, bookings, waitlist_count: waiting, reconciliation: rec }) {
    emptyPanel.hidden = true;
    panel.hidden = false;
    const d = date(ev.starts_at);
    const [label, cls] = STATUS[ev.status];
    const checkedIn = bookings.filter((b) => b.status === 'checked_in').length;
    const confirmed = bookings.filter((b) => b.status === 'confirmed').length;
    const pending = bookings.filter((b) => b.status === 'pending').length;
    const toggle = ev.status === 'draft' ? ['open', 'Publish event', 'btn']
      : ev.status === 'open' ? ['closed', 'Close bookings', 'btn btn-danger']
      : ['open', 'Reopen bookings', 'btn btn-ghost'];

    const shown = bookings.slice(0, MAX_ROWS);
    const rows = shown.map((b) => {
      const [bl, bc] = BOOKING[b.status];
      const isArmed = String(armed) === String(b.id);
      const approveBtn = b.status === 'pending'
        ? `<button class="btn btn-sm" type="button" data-act="approve" data-id="${esc(b.id)}">Approve</button>` : '';
      const buttons = (b.status === 'confirmed' || b.status === 'pending')
        ? `${approveBtn}${b.status === 'confirmed' ? `<button class="btn btn-ghost btn-sm" type="button" data-act="checkin" data-token="${esc(b.qr_token)}">Check in</button>` : ''}
           <button class="btn btn-danger btn-sm${isArmed ? ' armed' : ''}" type="button" data-act="cancel" data-id="${esc(b.id)}">${isArmed ? 'Click again to confirm' : (b.status === 'pending' ? 'Reject' : 'Cancel')}</button>`
        : '';
      return `<tr><td>${esc(b.email)}</td><td><span class="chip ${bc}">${bl}</span></td><td>${esc(date(b.created_at).full)}</td><td class="actions">${buttons}</td></tr>`;
    }).join('');

    panel.innerHTML = `
      <div class="panel-head">
        <div>
          <h2><span class="live" title="Updates every 2 seconds"></span>${esc(ev.title)}</h2>
          <p class="sub">${esc(d.full)}${ev.venue ? `<br>${esc(ev.venue)}` : ''}</p>
        </div>
        <div><span class="chip ${cls}">${label}</span> <button class="${toggle[2]} btn-sm" type="button" data-act="status" data-status="${toggle[0]}">${toggle[1]}</button></div>
      </div>
      <dl class="stats">
        <div class="stat"><dt>Seats left</dt><dd>${esc(ev.seats_left)}</dd></div>
        <div class="stat"><dt>Booked</dt><dd>${esc(confirmed + checkedIn + pending)}</dd></div>
        ${pending ? `<div class="stat"><dt>Awaiting approval</dt><dd>${esc(pending)}</dd></div>` : ''}
        <div class="stat"><dt>Checked in</dt><dd>${esc(checkedIn)}</dd></div>
        <div class="stat"><dt>On waitlist</dt><dd>${esc(waiting)}</dd></div>
      </dl>
      <p class="recon ${rec.ok ? '' : 'bad'}">${rec.ok
        ? `Counts match: ${esc(ev.seats_left)} left + ${esc(rec.active_bookings)} booked = ${esc(ev.total_seats)} seats.`
        : `Counts do not match: ${esc(ev.seats_left)} left + ${esc(rec.active_bookings)} booked is not ${esc(ev.total_seats)} seats.`}</p>
      <div class="table-wrap">
        ${bookings.length ? `<table><thead><tr><th>Student</th><th>Status</th><th>Booked</th><th></th></tr></thead><tbody>${rows}</tbody></table>
        ${bookings.length > MAX_ROWS ? `<p class="muted">Showing the first ${MAX_ROWS} of ${bookings.length} bookings.</p>` : ''}`
        : '<p class="muted">No bookings yet. They appear here the moment a student books.</p>'}
      </div>`;
  }

  panel.addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const { act } = btn.dataset;
    try {
      if (act === 'status') {
        const { event } = await api(`/events/${selected}/status`, { method: 'PATCH', body: { status: btn.dataset.status } });
        toast(event.status === 'open' ? 'Bookings are open.' : 'Bookings are closed.');
      } else if (act === 'checkin') {
        btn.disabled = true;
        const r = await api(`/checkin/${encodeURIComponent(btn.dataset.token)}`, { method: 'POST' });
        toast(`${r.booking.email} checked in.`);
      } else if (act === 'approve') {
        btn.disabled = true;
        await api(`/bookings/${btn.dataset.id}/approve`, { method: 'POST' });
        toast('Booking approved. The student now has a ticket.');
      } else if (act === 'cancel') {
        const id = btn.dataset.id;
        if (String(armed) !== String(id)) {
          armed = id;
          refreshPanel(true);
          setTimeout(() => { if (String(armed) === String(id)) { armed = null; refreshPanel(true); } }, 4000);
          return;
        }
        armed = null;
        btn.disabled = true;
        const r = await api(`/bookings/${id}`, { method: 'DELETE' });
        toast(r.promoted ? 'Booking cancelled. The first person on the waitlist got the seat.' : 'Booking cancelled. The seat is available again.');
      }
    } catch (err) {
      toast(err.message, 'error');
    }
    refreshPanel(true);
  });

  const delBtn = $('#delete-event');
  let delArmed = false;
  let delTimer = null;
  function disarmDelete() { delArmed = false; clearTimeout(delTimer); delBtn.textContent = 'Delete event'; delBtn.classList.remove('armed'); }

  delBtn.addEventListener('click', async () => {
    if (!selected) return;
    if (!delArmed) {
      delArmed = true;
      delBtn.textContent = 'Click again to delete for good';
      delBtn.classList.add('armed');
      delTimer = setTimeout(disarmDelete, 4000);
      return;
    }
    disarmDelete();
    delBtn.disabled = true;
    try {
      const r = await api(`/events/${selected}`, { method: 'DELETE' });
      toast(r.removed_bookings ? `Event deleted, along with ${r.removed_bookings} booking(s).` : 'Event deleted.');
      selected = null;
      clearInterval(pollTimer);
      panel.hidden = true;
      overrideEl.hidden = true;
      emptyPanel.hidden = false;
      await loadEvents();
      if (events.length) select(events[0].id);
    } catch (err) { toast(err.message, 'error'); }
    delBtn.disabled = false;
  });

  $('#capacity-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const r = await api(`/events/${selected}/capacity`, { method: 'PATCH', body: { total_seats: Number(capInput.value) } });
      toast(r.promoted ? `Seats updated. ${r.promoted} waitlisted student(s) got a seat.` : 'Seats updated.');
    } catch (err) { toast(err.message, 'error'); }
    refreshPanel(true);
  });

  $('#addstudent-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = $('#add-email');
    try {
      await api(`/events/${selected}/bookings`, { method: 'POST', body: { email: input.value } });
      toast('Seat booked for the student.');
      input.value = '';
    } catch (err) { toast(err.message, 'error'); }
    refreshPanel(true);
  });

  await loadEvents();
  if (events.length) select(events[0].id);
})();