(async function () {
  const { $, esc, api, renderNav } = CP;
  const user = await renderNav('checkin');
  if (!user || user.role !== 'organizer') { location.href = 'login.html'; return; }

  const input = $('#token');
  const result = $('#result');
  const history = $('#history');
  const log = [];

  $('#checkin-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    // Accept the bare code or a pasted link: keep only the last path segment.
    const token = input.value.trim().split('?')[0].split('/').pop();
    if (!token) return;

    let ok = false;
    let line;
    try {
      const r = await api(`/checkin/${encodeURIComponent(token)}`, { method: 'POST' });
      ok = true;
      result.className = 'result ok';
      result.innerHTML = `<strong>Checked in</strong>${esc(r.booking.email)} for ${esc(r.booking.title)}.`;
      line = `${r.booking.email} checked in to ${r.booking.title}`;
    } catch (err) {
      result.className = 'result bad';
      result.innerHTML = `<strong>Not checked in</strong>${esc(err.message)}`;
      line = `Refused: ${err.message}`;
    }
    result.hidden = false;
    log.unshift({ ok, line, at: new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' }) });
    history.innerHTML = log.slice(0, 8).map((l) => `<li>${esc(l.at)} - ${esc(l.line)}</li>`).join('');
    $('#history-box').hidden = false;
    input.value = '';
    input.focus();
  });

  input.focus();
})();
