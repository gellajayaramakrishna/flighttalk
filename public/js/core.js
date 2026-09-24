function createCabinApp(options) {
  const mode = options.mode;
  const tokenKey = options.tokenKey;
  const titles = options.titles;

  const state = {
    mode,
    token: localStorage.getItem(tokenKey) || '',
    user: null,
    socket: null,
    channel: mode === 'airline' ? 'lobby:airline' : 'lobby:general',
    view: 'lobby',
    users: [],
    rooms: [],
    activeRoom: null,
    gameState: null,
    reportTarget: null,
    files: []
  };

  const $ = (id) => document.getElementById(id);
  const gate = $('gate');
  const cabin = $('cabin');

  function api(path, opts = {}) {
    const headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
    if (state.token) headers['x-session-token'] = state.token;
    const body = opts.body instanceof FormData ? opts.body : (opts.body ? JSON.stringify(opts.body) : undefined);
    if (opts.body instanceof FormData) delete headers['Content-Type'];
    return fetch(path, { method: opts.method || 'GET', headers, body }).then(async (res) => {
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Request failed');
      return data;
    });
  }

  function initials(name) {
    return String(name || 'FT').slice(0, 2).toUpperCase();
  }

  function fmtTime(ts) {
    return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function fmtSize(n) {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / 1024 / 1024).toFixed(1)} MB`;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function btn(label, onClick) {
    const b = document.createElement('button');
    b.className = 'ghost';
    b.type = 'button';
    b.textContent = label;
    b.addEventListener('click', onClick);
    return b;
  }

  let pendingJoin = null;

  function cleanNameSuggestion(name) {
    const letters = String(name || '').replace(/[^A-Za-z]/g, '').toUpperCase();
    return letters.slice(0, 3) || 'FT';
  }

  function updateNameSuggestion() {
    const value = $('displayName').value.trim();
    const suggestion = value ? cleanNameSuggestion(value) : '';
    $('nameSuggestion').textContent = suggestion || '—';
    $('useSuggestion').disabled = !suggestion;

    const looksLong = value.length > 12 || /\s/.test(value);
    $('fullNameWarning').classList.toggle('hidden', !looksLong);
    if (!looksLong) $('fullNameAck').checked = false;
  }

  function showDetailsStep() {
    $('scanStep').classList.add('hidden');
    $('joinForm').classList.remove('hidden');
    $('detailsStep').classList.remove('hidden');
    $('nameStep').classList.add('hidden');

    const flight = $('flight').value.trim().toUpperCase();
    const seat = $('seat').value.trim().toUpperCase();
    $('flightDisplay').textContent = flight || 'Not detected';
    $('seatDisplay').textContent = seat || 'Not detected';
  }

  function showScanStep() {
    $('joinForm').classList.add('hidden');
    $('scanStep').classList.remove('hidden');
    $('ocrFile').value = '';
    $('ocrStatus').textContent = '';
  }

  $('detailsContinue').addEventListener('click', () => {
    const flight = $('flight').value.trim().toUpperCase();
    const seat = $('seat').value.trim().toUpperCase();

    if (!flight || !seat) {
      $('joinError').textContent = 'The flight and seat could not be read. Please rescan the boarding pass.';
      return;
    }

    $('joinError').textContent = '';
    $('detailsStep').classList.add('hidden');
    $('nameStep').classList.remove('hidden');
    $('displayName').value = '';
    updateNameSuggestion();
    $('displayName').focus();
  });

  $('displayName').addEventListener('input', updateNameSuggestion);

  $('useSuggestion').addEventListener('click', () => {
    $('displayName').value = $('nameSuggestion').textContent;
    updateNameSuggestion();
  });

  $('nameBack').addEventListener('click', () => {
    $('nameStep').classList.add('hidden');
    $('detailsStep').classList.remove('hidden');
  });

  $('joinForm').addEventListener('submit', (e) => {
    e.preventDefault();
    $('nameError').textContent = '';

    const displayName = $('displayName').value.trim();
    const flight = $('flight').value.trim().toUpperCase();
    const seat = $('seat').value.trim().toUpperCase();

    if (!displayName || displayName.length > 32) {
      $('nameError').textContent = 'Please choose a display name between 1 and 32 characters.';
      return;
    }

    if (!$('nameAck').checked) {
      $('nameError').textContent = 'Please acknowledge that your display name may be visible to other passengers.';
      return;
    }

    const looksLong = displayName.length > 12 || /\s/.test(displayName);
    if (looksLong && !$('fullNameAck').checked) {
      $('nameError').textContent = 'Please acknowledge the privacy warning before using this name.';
      return;
    }

    pendingJoin = {
      mode,
      // The server still expects this legacy field, but we do not ask the passenger
      // to enter or upload a full name. Store only the chosen display name.
      fullName: displayName,
      flight,
      seat,
      displayName
    };

    $('previewFlight').textContent = flight;
    $('previewSeat').textContent = seat;
    $('previewDisplayName').textContent = displayName;
    $('boardingPreview').classList.remove('hidden');
  });

  $('previewBack').addEventListener('click', () => {
    $('boardingPreview').classList.add('hidden');
  });

  $('previewContinue').addEventListener('click', async () => {
    if (!pendingJoin) return;
    $('nameError').textContent = '';
    const button = $('previewContinue');
    button.disabled = true;
    button.textContent = 'Entering…';

    try {
      const data = await api('/api/auth/join', { method: 'POST', body: pendingJoin });
      if (data.user.mode !== mode) throw new Error('Wrong app profile');
      state.token = data.token;
      state.user = data.user;
      localStorage.setItem(tokenKey, data.token);
      $('boardingPreview').classList.add('hidden');
      enterCabin();
    } catch (err) {
      $('boardingPreview').classList.add('hidden');
      $('nameError').textContent = err.message;
    } finally {
      button.disabled = false;
      button.textContent = 'I Understand — Enter FlightTalk';
    }
  });

  $('rescanBtn').addEventListener('click', showScanStep);

  if ($('ocrFile')) {
    $('ocrFile').addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;

      $('ocrStatus').textContent = 'Reading boarding pass…';
      try {
        const result = await window.Tesseract.recognize(file, 'eng', {
          workerPath: '/vendor/tesseract/dist/worker.min.js',
          corePath: '/vendor/tesseract-core',
          langPath: '/vendor/tessdata',
          gzip: true,
          logger: (m) => {
            if (m.status === 'recognizing text') {
              $('ocrStatus').textContent = `Reading ${Math.round(m.progress * 100)}%`;
            }
          }
        });

        const rawText = result.data.text;
        const text = rawText.toUpperCase();
        const flight = text.match(/\b([A-Z0-9]{2,3}\s*\d{3,4})\b/);
        const seat = text.match(/\b(\d{1,3}[A-K])\b/);
        if (flight) {
          const normalizedFlight = flight[1].replace(/\s+/g, '').replace(/^A[L1](?=\d)/, 'AI');
          $('flight').value = normalizedFlight;
        }
        if (seat) $('seat').value = seat[1];

        $('ocrStatus').textContent = 'Boarding pass read. Please confirm the detected details.';
        showDetailsStep();
      } catch {
        $('ocrStatus').textContent = 'Could not read the image locally. Try another photo.';
      }
    });
  }

  async function enterCabin() {
    gate.classList.add('hidden');
    cabin.classList.remove('hidden');
    $('meName').textContent = state.user.displayName;
    $('meAvatar').textContent = initials(state.user.displayName);
    $('meMeta').textContent = mode === 'airline'
      ? `${state.user.flight} · ${state.user.seat}`
      : 'Local session';
    $('openToChat').checked = state.user.openToChat;
    $('dnd').checked = state.user.dnd;
    connectSocket();
    await refreshAll();
    showView('lobby');
  }

  function connectSocket() {
    if (state.socket) state.socket.disconnect();
    state.socket = io({ auth: { token: state.token } });
    state.socket.on('connect', () => {
      state.socket.emit('chat:join', state.channel);
    });
    state.socket.on('session:replaced', (info) => {
      alert(info.reason || 'Signed in elsewhere');
      location.reload();
    });
    state.socket.on('presence:update', (users) => {
      state.users = users.filter((u) => u.mode === mode);
      renderPeople();
      renderRooms();
    });
    state.socket.on('chat:message', (message) => {
      if (message.channel === state.channel) appendMessage(message);
    });
    state.socket.on('chat:typing', (payload) => {
      if (payload.channel !== state.channel) return;
      $('typing').textContent = payload.typing ? `${payload.user.displayName} is typing…` : '';
    });
    state.socket.on('rooms:update', (room) => {
      const idx = state.rooms.findIndex((r) => r.id === room.id);
      if (idx >= 0) state.rooms[idx] = room;
      else state.rooms.unshift(room);
      if (state.activeRoom && state.activeRoom.id === room.id) state.activeRoom = room;
      renderRooms();
      renderGameLobby();
    });
    state.socket.on('rooms:removed', (id) => {
      state.rooms = state.rooms.filter((r) => r.id !== id);
      if (state.activeRoom?.id === id) {
        state.activeRoom = null;
        $('roomPanel').classList.add('hidden');
        $('gameBoard').classList.add('hidden');
      }
      renderRooms();
      renderGameLobby();
    });
    state.socket.on('rooms:kicked', ({ roomId, userId }) => {
      if (userId === state.user.id && state.activeRoom?.id === roomId) {
        state.activeRoom = null;
        alert('You were removed from the room.');
      }
    });
    state.socket.on('files:new', (file) => {
      if (file.channel === state.channel) {
        state.files.unshift(file);
        renderFiles();
      }
    });
    state.socket.on('game:state', ({ roomId, state: gs }) => {
      if (state.activeRoom?.id === roomId) {
        state.gameState = gs;
        renderGame(gs);
      }
    });
    state.socket.on('watch:sync', ({ roomId, state: ws }) => {
      if (state.activeRoom?.id === roomId) {
        const el = document.getElementById('watchMeta');
        if (el) el.textContent = `${ws.playing ? 'Playing' : 'Paused'} ${ws.mediaName || ''} @ ${Math.floor(ws.time)}s`;
      }
    });
  }

  async function refreshAll() {
    const [users, rooms, messages, files] = await Promise.all([
      api('/api/users'),
      api('/api/rooms'),
      api(`/api/messages?channel=${encodeURIComponent(state.channel)}`),
      api(`/api/files?channel=${encodeURIComponent(state.channel)}`)
    ]);
    state.users = users.users;
    state.rooms = rooms.rooms;
    state.files = files.files;
    renderPeople();
    renderRooms();
    renderFiles();
    renderGameLobby();
    const box = $('messages');
    box.innerHTML = '';
    messages.messages.forEach(appendMessage);
  }

  function showView(name) {
    state.view = name;
    document.querySelectorAll('.nav-btn').forEach((btn) => btn.classList.toggle('active', btn.dataset.view === name));
    document.querySelectorAll('.view').forEach((el) => el.classList.add('hidden'));
    $(`view-${name}`).classList.remove('hidden');
    $('viewTitle').textContent = titles[name][0];
    $('viewSub').textContent = titles[name][1];
  }

  document.querySelectorAll('.nav-btn').forEach((btn) => {
    btn.addEventListener('click', () => showView(btn.dataset.view));
  });

  function appendMessage(message) {
    const el = document.createElement('div');
    el.className = `bubble${message.sender.id === state.user.id ? ' mine' : ''}`;
    el.innerHTML = `<b>${escapeHtml(message.sender.displayName)}</b>${escapeHtml(message.content)}<time>${fmtTime(message.createdAt)}${message.filtered ? ' · filtered' : ''}</time>`;
    $('messages').appendChild(el);
    $('messages').scrollTop = $('messages').scrollHeight;
  }

  $('composer').addEventListener('submit', (e) => {
    e.preventDefault();
    const content = $('messageInput').value.trim();
    if (!content || !state.socket) return;
    state.socket.emit('chat:message', { channel: state.channel, content }, (res) => {
      if (!res?.ok) alert(res?.error || 'Could not send');
    });
    $('messageInput').value = '';
  });

  $('messageInput').addEventListener('input', () => {
    if (state.socket) state.socket.emit('chat:typing', { channel: state.channel });
  });

  async function saveSettings() {
    const data = await api('/api/me/settings', {
      method: 'POST',
      body: { openToChat: $('openToChat').checked, dnd: $('dnd').checked }
    });
    state.user = data.user;
  }
  $('openToChat').addEventListener('change', saveSettings);
  $('dnd').addEventListener('change', saveSettings);

  function renderPeople() {
    const box = $('peopleList');
    box.innerHTML = '';
    const others = state.users.filter((u) => u.id !== state.user.id && u.mode === mode);
    if (!others.length) {
      box.innerHTML = `<div class="card"><div><h3>${mode === 'airline' ? 'No other passengers yet' : 'Empty cabin'}</h3><p>Waiting for other devices on this local network.</p></div></div>`;
      return;
    }
    others.forEach((u) => {
      const card = document.createElement('div');
      card.className = 'card';
      const meta = mode === 'airline' ? `${u.flight || ''} ${u.seat || ''}`.trim() : 'General';
      card.innerHTML = `
        <div>
          <h3>${escapeHtml(u.displayName)}</h3>
          <p>${escapeHtml(meta)} · ${u.openToChat ? 'Open to chat' : 'Not discoverable'} · ${u.dnd ? 'DND' : 'Available'}</p>
        </div>
        <div class="actions"></div>`;
      const actions = card.querySelector('.actions');
      if (u.openToChat) actions.appendChild(btn('Message', () => openDm(u)));
      actions.appendChild(btn('Block', () => blockUser(u.id)));
      actions.appendChild(btn('Report', () => openReport(u.id)));
      box.appendChild(card);
    });
  }

  async function openDm(user) {
    if (!user.openToChat) return;
    state.channel = ['dm', ...[state.user.id, user.id].sort()].join(':');
    if (state.socket) state.socket.emit('chat:join', state.channel);
    showView('lobby');
    $('viewTitle').textContent = user.displayName;
    $('viewSub').textContent = mode === 'airline' ? 'Private passenger chat' : 'Private chat';
    await refreshAll();
  }

  async function blockUser(id) {
    await api('/api/block', { method: 'POST', body: { userId: id } });
    alert('Blocked silently. They will not be notified.');
  }

  function openReport(id) {
    state.reportTarget = id;
    $('modal').classList.remove('hidden');
  }
  $('modalCancel').addEventListener('click', () => $('modal').classList.add('hidden'));
  $('reportForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    await api('/api/report', {
      method: 'POST',
      body: {
        userId: state.reportTarget,
        reason: $('reportReason').value,
        details: $('reportDetails').value
      }
    });
    $('modal').classList.add('hidden');
    $('reportDetails').value = '';
    alert('Report stored for this session.');
  });

  $('roomKind').addEventListener('change', () => {
    $('gameType').style.display = $('roomKind').value === 'game' ? '' : 'none';
  });
  $('gameType').style.display = 'none';

  $('roomForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const data = await api('/api/rooms', {
      method: 'POST',
      body: {
        name: $('roomName').value.trim() || 'Room',
        kind: $('roomKind').value,
        gameType: $('gameType').value
      }
    });
    $('roomName').value = '';
    await joinRoom(data.room.id);
  });

  function renderRooms() {
    const box = $('roomsList');
    box.innerHTML = '';
    if (!state.rooms.length) {
      box.innerHTML = '<div class="card"><div><h3>No rooms yet</h3><p>Create a chat or game room to get a short ID.</p></div></div>';
      return;
    }
    state.rooms.forEach((room) => {
      const card = document.createElement('div');
      card.className = 'card';
      card.innerHTML = `
        <div>
          <h3>${escapeHtml(room.name)} <span class="chip">${room.id}</span></h3>
          <p>${room.kind}${room.gameType ? ' · ' + room.gameType : ''} · ${room.members.length}/${room.capacity}</p>
        </div>
        <div class="actions"></div>`;
      card.querySelector('.actions').appendChild(btn('Join', () => joinRoom(room.id)));
      box.appendChild(card);
    });
  }

  async function joinRoom(id) {
    const data = await api(`/api/rooms/${id}/join`, { method: 'POST' });
    state.activeRoom = data.room;
    state.channel = `room:${id}`;
    if (state.socket) state.socket.emit('chat:join', state.channel);
    renderRoomPanel();
    showView(data.room.kind === 'game' ? 'games' : 'rooms');
    await refreshAll();
    if (data.room.kind === 'game') {
      state.activeRoom = data.room;
      renderGameLobby();
    }
  }

  function renderRoomPanel() {
    const panel = $('roomPanel');
    const room = state.activeRoom;
    if (!room) {
      panel.classList.add('hidden');
      return;
    }
    panel.classList.remove('hidden');
    panel.innerHTML = '';
    const head = document.createElement('div');
    head.innerHTML = `<h3>${escapeHtml(room.name)} · ${room.id}</h3><p class="hint">Host controls kick and game start.</p>`;
    panel.appendChild(head);
    room.members.forEach((m) => {
      const row = document.createElement('div');
      row.className = 'card';
      row.innerHTML = `<div><h3>${escapeHtml(m.displayName)}</h3><p>${m.id === room.hostId ? 'Host' : 'Member'}</p></div>`;
      const actions = document.createElement('div');
      actions.className = 'actions';
      if (state.user.id === room.hostId && m.id !== state.user.id) {
        actions.appendChild(btn('Kick', async () => {
          await api(`/api/rooms/${room.id}/kick`, { method: 'POST', body: { userId: m.id } });
        }));
      }
      row.appendChild(actions);
      panel.appendChild(row);
    });
    const tools = document.createElement('div');
    tools.className = 'actions';
    tools.style.marginTop = '12px';
    tools.appendChild(btn('Leave', async () => {
      await api(`/api/rooms/${room.id}/leave`, { method: 'POST' });
      state.activeRoom = null;
      state.channel = mode === 'airline' ? 'lobby:airline' : 'lobby:general';
      panel.classList.add('hidden');
      await refreshAll();
    }));
    if (room.kind === 'game' && state.user.id === room.hostId) {
      tools.appendChild(btn('Start game', async () => {
        const data = await api(`/api/rooms/${room.id}/start`, { method: 'POST' });
        state.gameState = data.state;
        renderGame(data.state);
        showView('games');
      }));
    }
    if (room.kind === 'chat' && state.user.id === room.hostId) {
      tools.appendChild(btn('Watch together', () => renderWatch(room)));
    }
    panel.appendChild(tools);
  }

  function renderWatch(room) {
    const board = $('gameBoard');
    board.classList.remove('hidden');
    board.innerHTML = `
      <h3>Watch together</h3>
      <p class="hint">Playback state is synced. Each device plays its own local copy.</p>
      <input id="mediaName" placeholder="Local media name, e.g. cabin-film.mp4" />
      <div class="actions" style="margin-top:12px">
        <button class="ghost" type="button" id="watchPlay">Play</button>
        <button class="ghost" type="button" id="watchPause">Pause</button>
      </div>
      <p id="watchMeta" class="hint"></p>`;
    const emit = (playing) => {
      state.socket.emit('watch:sync', {
        roomId: room.id,
        playing,
        time: 0,
        mediaName: $('mediaName').value
      });
      $('watchMeta').textContent = playing ? 'Playing' : 'Paused';
    };
    $('watchPlay').onclick = () => emit(true);
    $('watchPause').onclick = () => emit(false);
    showView('games');
  }

  function renderGameLobby() {
    const box = $('gameLobby');
    box.innerHTML = '';
    const games = state.rooms.filter((r) => r.kind === 'game');
    if (!games.length) {
      box.innerHTML = '<div class="card"><div><h3>No game rooms</h3><p>Create one under Rooms.</p></div></div>';
      return;
    }
    games.forEach((room) => {
      const card = document.createElement('div');
      card.className = 'card';
      card.innerHTML = `<div><h3>${escapeHtml(room.name)}</h3><p>${room.gameType} · ${room.members.length}/${room.capacity}</p></div>`;
      const actions = document.createElement('div');
      actions.className = 'actions';
      actions.appendChild(btn('Open', () => joinRoom(room.id)));
      card.appendChild(actions);
      box.appendChild(card);
    });
    if (state.activeRoom && state.gameState) renderGame(state.gameState);
  }

  function renderGame(gs) {
    const board = $('gameBoard');
    board.classList.remove('hidden');
    board.innerHTML = '';
    const currentId = Array.isArray(gs.players) && gs.players[0] && typeof gs.players[0] === 'object'
      ? gs.players[gs.turn]?.userId
      : gs.players[gs.turn];
    const title = document.createElement('h3');
    title.textContent = gs.winner
      ? `Winner: ${nameOf(gs.winner)}`
      : gs.draw
        ? 'Draw'
        : `${gs.type} · ${nameOf(currentId)}`;
    board.appendChild(title);
    if (gs.type === 'tictactoe') renderTtt(board, gs);
    if (gs.type === 'connectfour') renderC4(board, gs);
    if (gs.type === 'ludo') renderLudo(board, gs);
  }

  function nameOf(id) {
    const u = state.users.find((x) => x.id === id) || (state.user.id === id ? state.user : null);
    return u ? u.displayName : String(id || '').slice(0, 4);
  }

  function playerId(gs) {
    return Array.isArray(gs.players) && typeof gs.players[0] === 'string'
      ? gs.players
      : gs.players.map((p) => p.userId);
  }

  function renderTtt(board, gs) {
    const grid = document.createElement('div');
    grid.className = 'board-ttt';
    gs.board.forEach((val, i) => {
      const b = document.createElement('button');
      b.className = 'cell';
      b.textContent = val || '';
      b.onclick = () => sendAction({ cell: i });
      grid.appendChild(b);
    });
    board.appendChild(grid);
  }

  function renderC4(board, gs) {
    const grid = document.createElement('div');
    grid.className = 'board-c4';
    for (let r = 0; r < 6; r += 1) {
      for (let c = 0; c < 7; c += 1) {
        const b = document.createElement('button');
        b.className = `cell c4 ${gs.board[r][c] || ''}`;
        b.onclick = () => sendAction({ col: c });
        grid.appendChild(b);
      }
    }
    board.appendChild(grid);
  }

  function renderLudo(board, gs) {
    const wrap = document.createElement('div');
    wrap.className = 'ludo';
    const info = document.createElement('p');
    info.className = 'hint';
    info.textContent = gs.dice ? `Dice: ${gs.dice}` : 'Roll to move. 6 leaves the yard.';
    board.appendChild(info);
    gs.players.forEach((p, idx) => {
      const col = document.createElement('div');
      col.className = 'ludo-player';
      col.innerHTML = `<h3>${escapeHtml(nameOf(p.userId))}</h3><p>${p.color}${idx === gs.turn ? ' · to play' : ''}</p>`;
      p.pieces.forEach((pos, i) => {
        const b = document.createElement('button');
        b.className = `piece ${p.color}`;
        b.title = `Piece ${i + 1}: ${pos}`;
        b.textContent = pos === -1 ? 'Y' : pos === 106 ? 'H' : pos;
        b.onclick = () => sendAction({ kind: 'move', piece: i });
        col.appendChild(b);
      });
      wrap.appendChild(col);
    });
    board.appendChild(wrap);
    if (playerId(gs)[gs.turn] === state.user.id && !gs.rolled && !gs.winner) {
      board.appendChild(btn('Roll dice', () => sendAction({ kind: 'roll' })));
    }
    if (gs.log?.length) {
      const log = document.createElement('p');
      log.className = 'hint';
      log.textContent = gs.log[0];
      board.appendChild(log);
    }
  }

  function sendAction(action) {
    if (!state.activeRoom || !state.socket) return;
    state.socket.emit('game:action', { roomId: state.activeRoom.id, action }, (res) => {
      if (!res?.ok) alert(res?.error || 'Illegal move');
    });
  }

  $('fileForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const file = $('fileInput').files[0];
    if (!file) return;
    $('fileProgress').textContent = 'Uploading…';
    try {
      if (file.size > 4 * 1024 * 1024) await uploadChunked(file);
      else {
        const body = new FormData();
        body.append('file', file);
        body.append('channel', state.channel);
        await api('/api/files', { method: 'POST', body });
      }
      $('fileProgress').textContent = 'Shared.';
      $('fileInput').value = '';
      await refreshAll();
    } catch (err) {
      $('fileProgress').textContent = err.message;
    }
  });

  async function uploadChunked(file) {
    const init = await api('/api/files/chunk/init', {
      method: 'POST',
      body: { channel: state.channel, filename: file.name, size: file.size, mime: file.type }
    });
    const chunkSize = init.chunkSize;
    let offset = 0;
    let index = 0;
    while (offset < file.size) {
      const blob = file.slice(offset, offset + chunkSize);
      const body = new FormData();
      body.append('uploadId', init.uploadId);
      body.append('index', String(index));
      body.append('chunk', blob, `chunk-${index}`);
      await api('/api/files/chunk', { method: 'POST', body });
      offset += chunkSize;
      index += 1;
      $('fileProgress').textContent = `Uploading ${Math.min(100, Math.round((offset / file.size) * 100))}%`;
    }
    await api('/api/files/chunk/complete', { method: 'POST', body: { uploadId: init.uploadId } });
  }

  function renderFiles() {
    const box = $('filesList');
    box.innerHTML = '';
    if (!state.files.length) {
      box.innerHTML = '<div class="card"><div><h3>No files in this channel</h3><p>Share a file to store it on the local server.</p></div></div>';
      return;
    }
    state.files.forEach((f) => {
      const card = document.createElement('div');
      card.className = 'card';
      card.innerHTML = `
        <div>
          <h3>${escapeHtml(f.filename)}</h3>
          <p>${fmtSize(f.size)} · ${escapeHtml(f.sender?.displayName || 'unknown')}</p>
        </div>
        <div class="actions"><a class="ghost" href="${f.url}" download>Download</a></div>`;
      box.appendChild(card);
    });
  }

  async function boot() {
    if (!state.token) return;
    try {
      const data = await api('/api/me');
      if (data.user.mode !== mode) {
        localStorage.removeItem(tokenKey);
        state.token = '';
        return;
      }
      state.user = data.user;
      enterCabin();
    } catch {
      localStorage.removeItem(tokenKey);
      state.token = '';
    }
  }

  boot();
}
