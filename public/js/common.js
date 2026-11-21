// Shared helpers. Everything user-supplied goes through esc() before it touches innerHTML.
(function () {
  const $ = (sel, root = document) => root.querySelector(sel);

  const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

  async function api(path, { method = 'GET', body } = {}) {
    const res = await fetch('/api' + path, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      credentials: 'same-origin',
    });
    let data = null;
    try { data = await res.json(); } catch { /* empty body */ }
    if (!res.ok) {
      const err = new Error((data && data.error && data.error.message) || 'Something went wrong. Try again.');
      err.code = data && data.error && data.error.code;
      err.status = res.status;
      throw err;
    }
    return data;
  }

  function toast(message, type = 'ok') {
    let box = $('#toasts');
    if (!box) {
      box = document.createElement('div');
      box.id = 'toasts';
      box.className = 'toasts';
      box.setAttribute('aria-live', 'polite');
      document.body.appendChild(box);
    }
    const el = document.createElement('div');
    el.className = `toast toast-${type}`;
    el.textContent = message;
    box.appendChild(el);
    setTimeout(() => el.remove(), 4200);
  }

  function date(iso) {
    const d = new Date(iso);
    return {
      mon: d.toLocaleString([], { month: 'short' }),
      day: d.getDate(),
      time: d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }),
      full: d.toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }),
    };
  }

  async function renderNav(active) {
    let user = null;
    try { user = (await api('/auth/me')).user; } catch { /* offline: show logged-out nav */ }

    const link = (href, label, key) => `<a href="${href}"${key === active ? ' aria-current="page"' : ''}>${label}</a>`;
    let html = link('index.html', 'Events', 'events');
    if (user && user.role === 'student') html += link('tickets.html', 'My tickets', 'tickets');
    if (user && user.role === 'organizer') html += link('organizer.html', 'Dashboard', 'organizer') + link('checkin.html', 'Check-in', 'checkin');
    if (user) html += `<span class="who">${esc(user.email)}</span><button class="link-btn" id="logout" type="button">Log out</button>`;
    else html += link('login.html', 'Log in', 'login') + '<a class="nav-cta" href="register.html">Sign up</a>';

    $('#nav').innerHTML = html;
    const out = $('#logout');
    if (out) out.addEventListener('click', async () => { await api('/auth/logout', { method: 'POST' }); location.href = 'index.html'; });
    return user;
  }

  window.CP = { $, esc, api, toast, date, renderNav };
})();
