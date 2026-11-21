(async function () {
  const { $, esc, api, toast, date, renderNav } = CP;
  const user = await renderNav('events');
  const root = $('#events');
  const isStudent = Boolean(user && user.role === 'student');

  async function fetchState() {
    const { events } = await api('/events');
    let bookings = [];
    let waitlist = [];
    if (isStudent) [{ bookings }, { waitlist }] = await Promise.all([api('/bookings/mine'), api('/waitlist/mine')]);
    return { events, bookings, waitlist };
  }

  function actionFor(ev, mine) {
    const same = (x) => String(x.event_id) === String(ev.id);
    if (!user) return ev.status === 'closed'
      ? '<span class="chip chip-muted">Bookings closed</span>'
      : '<a class="btn" href="login.html">Log in to book</a>';
    if (!isStudent) return '<span class="muted">Organizer view</span>';

    const ticket = mine.bookings.find((b) => same(b) && (b.status === 'pending' || b.status === 'confirmed' || b.status === 'checked_in'));
    if (ticket && ticket.status === 'pending') return '<span class="chip chip-warn">Awaiting approval</span><a class="btn btn-quiet btn-sm" href="tickets.html">View request</a>';
    if (ticket) return '<span class="chip chip-ok">You have a seat</span><a class="btn btn-quiet btn-sm" href="tickets.html">View ticket</a>';

    const waiting = mine.waitlist.find(same);
    if (waiting) return `<span class="chip chip-warn">Waitlist: number ${waiting.position}</span><button class="btn btn-quiet btn-sm" type="button" data-act="leave" data-id="${esc(ev.id)}">Leave waitlist</button>`;

    if (ev.status === 'closed') return '<span class="chip chip-muted">Bookings closed</span>';
    if (ev.seats_left === 0) return `<button class="btn btn-ghost" type="button" data-act="waitlist" data-id="${esc(ev.id)}">Join waitlist</button>`;
    return `<button class="btn" type="button" data-act="book" data-id="${esc(ev.id)}">Book a seat</button>`;
  }

  function seatsLabel(ev) {
    if (ev.status === 'open' && ev.seats_left === 0) return 'Sold out';
    return `${ev.seats_left} of ${ev.total_seats} ${ev.total_seats === 1 ? 'seat' : 'seats'} left`;
  }

  function render(state) {
    if (!state.events.length) {
      root.innerHTML = '<div class="empty"><strong>No upcoming events yet</strong>Events appear here as soon as an organizer publishes them.</div>';
      return;
    }
    root.innerHTML = state.events.map((ev) => {
      const d = date(ev.starts_at);
      const taken = ev.total_seats - ev.seats_left;
      const level = ev.seats_left === 0 ? 'full' : ev.seats_left <= Math.ceil(ev.total_seats * 0.15) ? 'low' : '';
      return `
        <article class="event">
          <div class="when"><span class="when-mon">${esc(d.mon)}</span><span class="when-day">${esc(d.day)}</span><span class="when-time">${esc(d.time)}</span></div>
          <div class="event-main">
            <h3>${esc(ev.title)}</h3>
            ${ev.venue ? `<p class="venue">${esc(ev.venue)}</p>` : ''}
            ${ev.description ? `<p class="desc">${esc(ev.description)}</p>` : ''}
            <div class="seats"><progress class="${level}" max="${esc(ev.total_seats)}" value="${esc(taken)}" aria-label="Seats taken"></progress><span>${esc(seatsLabel(ev))}</span></div>
          </div>
          <div class="event-action">${actionFor(ev, state)}</div>
        </article>`;
    }).join('');
  }

  async function refresh() {
    try {
      render(await fetchState());
    } catch (err) {
      root.innerHTML = `<div class="empty"><strong>Could not load events</strong>${esc(err.message)}<br><button class="btn btn-quiet btn-sm" type="button" data-act="retry">Try again</button></div>`;
    }
  }

  root.addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const { act, id } = btn.dataset;
    if (act === 'retry') return refresh();
    btn.disabled = true;
    try {
      if (act === 'book') {
        const r = await api(`/events/${id}/book`, { method: 'POST' });
        toast(r.booking.status === 'pending' ? 'Seat reserved. The organizer must approve it before it becomes a ticket.' : 'Seat booked. Your ticket is under My tickets.');
      } else if (act === 'waitlist') {
        const r = await api(`/events/${id}/waitlist`, { method: 'POST' });
        toast(`You are number ${r.position} on the waitlist.`);
      } else if (act === 'leave') {
        await api(`/events/${id}/waitlist`, { method: 'DELETE' });
        toast('You left the waitlist.');
      }
    } catch (err) {
      toast(err.message, 'error');
    }
    refresh();
  });

  await refresh();
  setInterval(() => { if (!document.hidden) refresh(); }, 5000); // keep seat counts live
})();