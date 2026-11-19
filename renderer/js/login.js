document.addEventListener('DOMContentLoaded', () => {
  const loginPanel = document.getElementById('loginPanel');
  const createPanel = document.getElementById('createPanel');
  const username = document.getElementById('username');
  const password = document.getElementById('password');
  const loginBtn = document.getElementById('loginBtn');
  const loginMessage = document.getElementById('loginMessage');
  const createBtn = document.getElementById('createBtn');
  const createMessage = document.getElementById('createMessage');

  function setMessage(element, text, type = 'error') {
    element.textContent = text;
    element.className = `message ${type}`;
  }

  function showCreate() {
    loginPanel.classList.add('hidden');
    createPanel.classList.remove('hidden');
    document.getElementById('newUsername').focus();
  }

  function showLogin() {
    createPanel.classList.add('hidden');
    loginPanel.classList.remove('hidden');
    username.focus();
  }

  document.getElementById('showCreateBtn').addEventListener('click', showCreate);
  document.getElementById('showLoginBtn').addEventListener('click', showLogin);

  async function login() {
    const user = username.value.trim();
    const pass = password.value;
    if (!user || !pass) return setMessage(loginMessage, 'Enter a username and password.');

    loginBtn.disabled = true;
    setMessage(loginMessage, 'Checking local account…', 'success');
    try {
      const result = await window.api.login(user, pass);
      if (!result?.success) return setMessage(loginMessage, result?.message || 'Local login failed.');
      setMessage(loginMessage, 'Login successful.', 'success');
      window.location.href = result.redirect || 'shop/dashboard/control.html';
    } catch (err) {
      setMessage(loginMessage, `Local login error: ${err.message}`);
    } finally {
      loginBtn.disabled = false;
    }
  }

  loginBtn.addEventListener('click', login);
  password.addEventListener('keydown', event => {
    if (event.key === 'Enter') login();
  });

  createBtn.addEventListener('click', async () => {
    const account = {
      username: document.getElementById('newUsername').value.trim(),
      password: document.getElementById('newPassword').value,
      shop_name: document.getElementById('shopName').value.trim(),
      shop_address: document.getElementById('shopAddress').value.trim()
    };

    createBtn.disabled = true;
    setMessage(createMessage, 'Creating local account…', 'success');
    try {
      const result = await window.api.createLocalAccount(account);
      if (!result?.success) return setMessage(createMessage, result?.message || 'Could not create account.');
      setMessage(createMessage, 'Account created. Opening your dashboard…', 'success');
      window.location.href = result.redirect || 'shop/dashboard/control.html';
    } catch (err) {
      setMessage(createMessage, `Account creation error: ${err.message}`);
    } finally {
      createBtn.disabled = false;
    }
  });

  window.api.getLocalAccountStatus().then(status => {
    if (status?.success && !status.has_accounts) showCreate();
    else showLogin();
  }).catch(showLogin);
});
