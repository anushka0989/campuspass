// Login and register forms (one script, the page decides which form exists).
(async function () {
  const { $, api, renderNav } = CP;
  const user = await renderNav($('#login-form') ? 'login' : 'register');
  const go = (u) => { location.href = u.role === 'organizer' ? 'organizer.html' : 'index.html'; };
  if (user) { go(user); return; }

  const showError = (msg) => { $('#error').textContent = msg; };

  const login = $('#login-form');
  if (login) {
    login.addEventListener('submit', async (e) => {
      e.preventDefault();
      showError('');
      try {
        const { user: u } = await api('/auth/login', { method: 'POST', body: { email: $('#email').value, password: $('#password').value } });
        go(u);
      } catch (err) { showError(err.message); }
    });
  }

  const reg = $('#register-form');
  if (reg) {
    const role = $('#role');
    const codeField = $('#code-field');
    role.addEventListener('change', () => { codeField.hidden = role.value !== 'organizer'; });

    reg.addEventListener('submit', async (e) => {
      e.preventDefault();
      showError('');
      try {
        const body = { email: $('#email').value, password: $('#password').value, role: role.value };
        if (role.value === 'organizer') body.inviteCode = $('#invite').value;
        const { user: u } = await api('/auth/register', { method: 'POST', body });
        go(u);
      } catch (err) { showError(err.message); }
    });
  }
})();
