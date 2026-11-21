(async function () {
  const { $, esc, api, toast, date, renderNav } = CP;
  const user = await renderNav('tickets');
  const root = $('#tickets');

  if (!user) { location.href = 'login.html'; return; }
  if (user.role !== 'student') {
    root.innerHTML = '<div class="box empty"><strong>Tickets are for student accounts</strong>Use the dashboard to see who booked your events.</div>';
    return;
  }

  let armed = null; // booking id waiting for a second click to confirm cancelling

  function ticketHtml(b) {
    const d = date(b.starts_at);
    const live = b.status === 'confirmed';
    const pending = b.status === 'pending';
    const chip = b.status === 'checked_in' ? '<span class="chip chip-ok">Checked in</span>'
      : pending ? '<span class="chip chip-warn">Awaiting approval</span>'
      : live ? '<span class="chip">Confirmed</span>' : '<span class="chip chip-muted">Cancelled</span>';
    const stub = live
      ? `<img src="/api/bookings/${esc(b.id)}/qr" width="150" height="150" alt="QR code for ${esc(b.title)}">`
      : b.status === 'checked_in' ? '<span class="stamp">Used</span>' : '';
    const isArmed = String(armed) === String(b.id);
    return `
      <article class="ticket ${esc(b.status)}">
        <div class="ticket-main">
          <h3>${esc(b.title)}</h3>
          <p class="when-line">${esc(d.full)}</p>
          ${b.venue ? `<p class="muted">${esc(b.venue)}</p>` : ''}
          ${chip}
          ${pending ? `<p class="muted">Your seat is held until the organizer approves it.</p>
          <div class="ticket-actions"><button class="btn btn-danger btn-sm${isArmed ? ' armed' : ''}" type="button" data-act="cancel" data-id="${esc(b.id)}">${isArmed ? 'Click again to cancel' : 'Cancel request'}</button></div>` : ''}
          ${live ? `<details><summary>Show check-in code</summary><code class="token">${esc(b.qr_token)}</code></details>
          <div class="ticket-actions"><button class="btn btn-danger btn-sm${isArmed ? ' armed' : ''}" type="button" data-act="cancel" data-id="${esc(b.id)}">${isArmed ? 'Click again to cancel' : 'Cancel booking'}</button></div>` : ''}
        </div>
        ${stub ? `<div class="ticket-stub">${stub}</div>` : ''}
      </article>`;
  }

  async function load() {
    const [{ bookings }, { waitlist }] = await Promise.all([api('/bookings/mine'), api('/waitlist/mine')]);
    const active = bookings.filter((b) => b.status !== 'cancelled');
    const cancelled = bookings.filter((b) => b.status === 'cancelled');

    let html = '';
    if (!active.length) html += '<div class="box empty"><strong>No tickets yet</strong><a href="index.html">Browse events</a> and book a seat.</div>';
    else html += active.map(ticketHtml).join('');

    if (waitlist.length) {
      html += '<h2 class="section-title">Waitlist</h2><div class="timetable">' + waitlist.map((w) => `
        <div class="waitrow">
          <div><strong>${esc(w.title)}</strong><br><span class="muted">${esc(date(w.starts_at).full)}</span></div>
          <div><span class="chip chip-warn">Number ${esc(w.position)} in line</span>
          <button class="btn btn-quiet btn-sm" type="button" data-act="leave" data-id="${esc(w.event_id)}">Leave</button></div>
        </div>`).join('') + '</div><p class="muted section-title">If a seat frees up, the first person in line is booked in automatically.</p>';
    }

    if (cancelled.length) html += '<h2 class="section-title">Cancelled</h2>' + cancelled.map(ticketHtml).join('');
    root.innerHTML = html;
  }

  root.addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const { act, id } = btn.dataset;
    try {
      if (act === 'cancel') {
        if (String(armed) !== String(id)) {
          armed = id;
          await load();
          setTimeout(() => { if (String(armed) === String(id)) { armed = null; load(); } }, 4000);
          return;
        }
        armed = null;
        btn.disabled = true;
        await api(`/bookings/${id}`, { method: 'DELETE' });
        toast('Booking cancelled. Your seat was released.');
      } else if (act === 'leave') {
        btn.disabled = true;
        await api(`/events/${id}/waitlist`, { method: 'DELETE' });
        toast('You left the waitlist.');
      }
    } catch (err) {
      toast(err.message, 'error');
    }
    load();
  });

  try { await load(); } catch (err) { root.innerHTML = `<div class="box empty"><strong>Could not load your tickets</strong>${esc(err.message)}</div>`; }
})();
