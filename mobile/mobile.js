(() => {
  const $ = (id) => document.getElementById(id);
  const params = new URLSearchParams(window.location.search);
  const session = params.get('session') || '';

  const clientIdKey = 'africa-bingo-local-mobile-client-id';
  const playerNameKey = 'africa-bingo-local-mobile-player-name';

  let clientId = localStorage.getItem(clientIdKey);
  if (!clientId) {
    clientId = (window.crypto?.randomUUID?.() || `client-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    localStorage.setItem(clientIdKey, clientId);
  }

  let playerName = localStorage.getItem(playerNameKey) || '';
  let source = null;
  let state = null;

  const playerNameInput = $('playerName');
  if (playerName) playerNameInput.value = playerName;

  function apiUrl(path) {
    const url = new URL(path, window.location.origin);
    url.searchParams.set('session', session);
    return url;
  }

  function showMessage(text) {
    const el = $('message');
    if (!text) {
      el.textContent = '';
      el.classList.add('hidden');
      return;
    }
    el.textContent = text;
    el.classList.remove('hidden');
  }

  function renderGrid(nextState) {
    const grid = $('grid');
    const total = Number(nextState.totalCards || 0);
    const selected = new Set(nextState.selectedCards || []);
    const mine = new Set(nextState.mySelectedCards || []);

    if (grid.childElementCount !== total) {
      grid.innerHTML = '';
      for (let cardId = 1; cardId <= total; cardId += 1) {
        const button = document.createElement('button');
        button.className = 'cartela';
        button.type = 'button';
        button.dataset.cardId = String(cardId);
        button.textContent = String(cardId);
        button.addEventListener('click', () => chooseCard(cardId));
        grid.appendChild(button);
      }
    }

    grid.querySelectorAll('.cartela').forEach((button) => {
      const cardId = Number(button.dataset.cardId);
      const isMine = mine.has(cardId);
      const isTaken = selected.has(cardId) && !isMine;
      button.classList.toggle('mine', isMine);
      button.classList.toggle('taken', isTaken);
      button.disabled = !nextState.approved || !nextState.selectionOpen || isTaken;
      button.setAttribute('aria-pressed', isMine ? 'true' : 'false');
    });
  }

  function render(nextState) {
    state = nextState;
    $('bingoName').textContent = nextState.bingoName || 'Africa Bingo Local';
    $('roundText').textContent = `Game ${nextState.roundNumber || 1}`;

    const cartelaLabel = nextState.cartelaLabel || nextState.cartelaType || 'Cartela';
    const totalCards = Number(nextState.totalCards || 0);

    if ($('cartelaText')) {
      $('cartelaText').textContent =
        `${cartelaLabel} · ${totalCards} available`;
    }

    $('selectedCount').textContent = `${(nextState.mySelectedCards || []).length} selected`;

    const badge = $('accessBadge');
    const status = $('statusText');

    if (nextState.denied) {
      badge.textContent = 'DENIED';
      status.textContent = 'The host denied this device.';
      showMessage('Ask the Bingo host to approve this phone if you should have access.');
    } else if (!nextState.approved) {
      badge.textContent = 'WAITING';
      status.textContent = 'Waiting for host approval…';
      showMessage('Keep this page open. The cartelas will unlock as soon as the host approves you.');
    } else if (!nextState.selectionOpen) {
      badge.textContent = 'LOCKED';
      status.textContent = `Game ${nextState.roundNumber || 1} selections are closed.`;
      showMessage('Your selected cartelas are locked for this game. When the host starts the next game, selection will open again automatically.');
    } else {
      badge.textContent = 'OPEN';
      status.textContent = 'Tap a cartela to select or unselect it.';
      showMessage('');
    }

    renderGrid(nextState);
  }

  async function refreshState() {
    const url = apiUrl('/api/state');
    url.searchParams.set('clientId', clientId);
    url.searchParams.set('name', playerName);
    const response = await fetch(url, { cache: 'no-store' });
    const body = await response.json();
    if (!response.ok || !body.ok) throw new Error(body.error || 'Could not join room.');
    render(body.state);
  }

  function connectEvents() {
    if (source) source.close();
    const url = apiUrl('/events');
    url.searchParams.set('clientId', clientId);
    url.searchParams.set('name', playerName);
    source = new EventSource(url);

    source.addEventListener('state', (event) => {
      try { render(JSON.parse(event.data)); } catch {}
    });

    source.addEventListener('room-ended', () => {
      showMessage('This local cartela room has ended.');
      $('statusText').textContent = 'Room ended';
      source.close();
      source = null;
    });

    source.onerror = () => {
      $('statusText').textContent = 'Reconnecting to the desktop…';
    };
  }

  async function chooseCard(cardId) {
    if (!state?.approved || !state.selectionOpen) return;
    const mine = new Set(state.mySelectedCards || []);
    const selected = !mine.has(cardId);

    try {
      const url = apiUrl('/api/select');
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientId, name: playerName, cardId, selected })
      });
      const body = await response.json();
      if (body.state) render(body.state);
      if (!response.ok || !body.ok) showMessage(body.error || 'Could not change cartela selection.');
    } catch {
      showMessage('The desktop is not reachable right now.');
    }
  }

  async function join() {
    const name = playerNameInput.value.trim().slice(0, 40);
    if (!session) {
      showMessage('This room link is missing its session code.');
      return;
    }
    if (!name) {
      playerNameInput.focus();
      return;
    }

    playerName = name;
    localStorage.setItem(playerNameKey, playerName);
    $('joinCard').classList.add('hidden');
    $('roomCard').classList.remove('hidden');

    try {
      await refreshState();
      connectEvents();
    } catch (error) {
      showMessage(error.message || 'Could not join this room.');
      $('statusText').textContent = 'Could not connect';
    }
  }

  $('joinBtn').addEventListener('click', join);
  playerNameInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') join();
  });
})();
