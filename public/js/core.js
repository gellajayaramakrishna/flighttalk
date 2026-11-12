/* FlightTalk passenger client. Plain JS, no build step, works fully offline. */
function createCabinApp(options) {
  'use strict';

  const TOKEN_KEY = options.tokenKey || 'ft_token';
  const $ = (id) => document.getElementById(id);

  const state = {
    token: localStorage.getItem(TOKEN_KEY) || '',
    user: null,
    cabin: { flightLock: '', quietMode: false, announcement: null },
    hidden: new Set(),
    blocks: [],
    socket: null,
    channel: 'lobby',
    channelInfo: { kind: 'lobby' },
    users: [],
    requests: { incoming: [], outgoing: [], contacts: [] },
    rooms: [],
    myRooms: new Set(),
    game: null, // { room, state }
    view: 'chat',
    scan: null,
    reportTarget: null,
    watch: { video: null, applying: false, last: null, heartbeat: null }
  };

  // ---------------------------------------------------------------------------
  // Small helpers
  // ---------------------------------------------------------------------------
  function el(tag, attrs, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat()) if (c != null) node.append(c.nodeType ? c : document.createTextNode(String(c)));
    return node;
  }
  const button = (label, onclick, cls = 'ghost') => el('button', { class: cls, type: 'button', onclick }, label);

  async function api(path, opts = {}) {
    const headers = {};
    if (state.token) headers['x-session-token'] = state.token;
    let body = opts.body;
    if (body && !(body instanceof FormData)) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(body);
    }
    const res = await fetch(path, { method: opts.method || (body ? 'POST' : 'GET'), headers, body });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && state.user) signOut('Your session ended. Please scan your boarding pass again.');
    if (!res.ok) throw new Error(data.error || 'Request failed');
    return data;
  }

  function toast(text, kind = 'info', ms = 3800) {
    const t = el('div', { class: `toast ${kind}` }, text);
    $('toasts').append(t);
    setTimeout(() => t.classList.add('out'), ms);
    setTimeout(() => t.remove(), ms + 400);
  }

  function confirmDialog(title, text, okLabel = 'OK') {
    return new Promise((resolve) => {
      $('confirmTitle').textContent = title;
      $('confirmText').textContent = text;
      $('confirmYes').textContent = okLabel;
      $('confirmModal').classList.remove('hidden');
      const done = (v) => {
        $('confirmModal').classList.add('hidden');
        $('confirmYes').onclick = null;
        $('confirmNo').onclick = null;
        resolve(v);
      };
      $('confirmYes').onclick = () => done(true);
      $('confirmNo').onclick = () => done(false);
    });
  }

  const fmtTime = (ts) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const fmtSize = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);
  const initials = (n) => String(n || 'FT').trim().slice(0, 2).toUpperCase();
  const GAME_NAMES = { tictactoe: 'Tic-Tac-Toe', connectfour: 'Connect Four', ludo: 'Ludo' };
  const nameOfUser = (id) => {
    if (state.user && id === state.user.id) return 'You';
    if (String(id).startsWith('bot:')) return `Bot ${String(id).slice(4)}`;
    const u = state.users.find((x) => x.id === id) || (state.game?.room.members || []).find((x) => x.id === id);
    return u ? u.displayName : 'Passenger';
  };

  // ---------------------------------------------------------------------------
  // Onboarding
  // ---------------------------------------------------------------------------
  function showStep(id) {
    for (const s of ['scanStep', 'confirmStep', 'nameStep']) $(s).classList.toggle('hidden', s !== id);
  }

  function setStatus(text, kind) {
    $('ocrStatus').textContent = text || '';
    $('ocrStatus').className = `ocr-status ${kind || ''}`;
  }

  async function loadCabinInfo() {
    try {
      const c = await api('/api/cabin');
      state.cabin = c;
      if (c.flightLock) {
        $('cabinFlight').textContent = `This cabin: flight ${c.flightLock}`;
        $('cabinFlight').classList.remove('hidden');
      }
    } catch { /* server not reachable yet */ }
  }

  function handleParsed(parsed) {
    if (state.cabin.flightLock) parsed = window.FTParse.pickLeg(parsed, state.cabin.flightLock);
    if (!parsed.flight || !parsed.seat) {
      const missing = [!parsed.flight && 'flight number', !parsed.seat && 'seat'].filter(Boolean).join(' and ');
      setStatus(`Couldn't read the ${missing}. Try again with the barcode filling the frame, or a sharper photo.`, 'error');
      return;
    }
    state.scan = parsed;
    setStatus('');
    $('sourceBadge').textContent = parsed.source === 'barcode'
      ? `✓ Read from the ${parsed.barcodeFormat || ''} barcode`
      : '◐ Read from printed text — please double-check';
    $('sourceBadge').className = `badge ${parsed.source === 'barcode' ? 'ok' : 'warn'}`;
    $('cFlight').textContent = parsed.flight;
    $('cSeat').textContent = parsed.seat;
    $('cRoute').textContent = parsed.from && parsed.to ? `${parsed.from} → ${parsed.to}` : '—';
    $('cDate').textContent = parsed.date || '—';
    $('cName').textContent = parsed.name ? `${parsed.name.surname} / ${parsed.name.given}`.replace(/^ \/ | \/ $/g, '') : 'Not readable';
    $('manualName').classList.toggle('hidden', Boolean(parsed.name));
    $('confirmError').textContent = '';
    showStep('confirmStep');
  }

  async function scanImage(file) {
    setStatus('Opening image…');
    try {
      const parsed = await window.FTScanner.scanFile(file, (t) => setStatus(t));
      handleParsed(parsed);
    } catch (err) {
      console.error(err);
      setStatus('Could not read that image. Try another photo.', 'error');
    }
  }

  let stopLive = null;
  function startLive() {
    if (!window.FTScanner.canLiveScan()) {
      setStatus('Live camera needs a secure (HTTPS) connection. Use "Upload / take photo" instead.', 'error');
      return;
    }
    $('liveBox').classList.remove('hidden');
    setStatus('Point the camera at the barcode on your boarding pass…');
    stopLive = window.FTScanner.startLiveScan($('liveVideo'), (parsed) => {
      $('liveBox').classList.add('hidden');
      if (navigator.vibrate) navigator.vibrate(60);
      handleParsed(parsed);
    }, (err) => {
      $('liveBox').classList.add('hidden');
      setStatus(err && err.name === 'NotAllowedError' ? 'Camera permission was denied.' : 'Camera not available. Use "Upload / take photo".', 'error');
    });
  }

  $('liveBtn').addEventListener('click', startLive);
  $('liveCancel').addEventListener('click', () => {
    if (stopLive) stopLive();
    $('liveBox').classList.add('hidden');
    setStatus('');
  });
  $('ocrFile').addEventListener('change', (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (f) scanImage(f);
  });
  $('rescanBtn').addEventListener('click', () => {
    state.scan = null;
    showStep('scanStep');
  });

  function scanName() {
    if (state.scan.name) return state.scan.name;
    const surname = $('mSurname').value.trim().toUpperCase();
    const given = $('mGiven').value.trim().toUpperCase();
    if (!surname && !given) return null;
    return { surname, given, full: `${surname}/${given}`, manual: true };
  }

  $('confirmBtn').addEventListener('click', () => {
    const name = scanName();
    if (!name || window.FTParse.identityKey(name).length < 2) {
      $('confirmError').textContent = 'Please type the name exactly as it appears on your boarding pass.';
      return;
    }
    const suggestion = window.FTParse.suggestDisplayName(name) || 'Guest';
    $('nameSuggestion').textContent = suggestion;
    $('displayName').value = '';
    $('nameError').textContent = '';
    updateNameWarning();
    showStep('nameStep');
    $('displayName').focus();
  });

  function updateNameWarning() {
    const v = $('displayName').value.trim();
    const name = state.scan && scanName();
    const sur = name ? name.surname.replace(/[^A-Z]/g, '') : '';
    const looksFull = v.length > 12 || /\s/.test(v) || (sur.length >= 4 && v.toUpperCase().includes(sur));
    $('fullNameWarning').classList.toggle('hidden', !looksFull);
  }
  $('displayName').addEventListener('input', updateNameWarning);
  $('useSuggestion').addEventListener('click', () => {
    $('displayName').value = $('nameSuggestion').textContent;
    updateNameWarning();
  });
  $('nameBack').addEventListener('click', () => showStep('confirmStep'));

  $('nameStep').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('nameError').textContent = '';
    if (!$('rulesAck').checked) {
      $('nameError').textContent = 'Please tick the box to agree to the cabin rules.';
      return;
    }
    const name = scanName();
    $('joinBtn').disabled = true;
    try {
      const data = await api('/api/auth/join', {
        body: {
          flight: state.scan.flight,
          seat: state.scan.seat,
          name: { surname: name.surname, given: name.given },
          manualName: Boolean(name.manual),
          source: state.scan.source,
          passDate: state.scan.date,
          displayName: $('displayName').value.trim(),
          openToChat: $('discoverable').checked
        }
      });
      state.token = data.token;
      state.user = data.user;
      state.scan = null; // drop the parsed pass from memory
      localStorage.setItem(TOKEN_KEY, data.token);
      enterCabin();
    } catch (err) {
      $('nameError').textContent = err.message;
    } finally {
      $('joinBtn').disabled = false;
    }
  });

  // ---------------------------------------------------------------------------
  // Cabin shell
  // ---------------------------------------------------------------------------
  const TITLES = {
    chat: ['Cabin chat', 'Everyone on this flight'],
    chats: ['Chats', 'Requests and private chats'],
    people: ['Passengers', 'Opt-in discovery only'],
    rooms: ['Rooms', 'Chat rooms and watch-together'],
    games: ['Games', 'Play offline with the cabin'],
    settings: ['Me', 'Privacy and safety']
  };

  function showView(name) {
    state.view = name;
    document.querySelectorAll('.nav-btn').forEach((b) => b.classList.toggle('active', b.dataset.view === name));
    document.querySelectorAll('.view').forEach((v) => v.classList.add('hidden'));
    $(`view-${name}`).classList.remove('hidden');
    if (name === 'chat') renderChatHeader();
    else {
      $('viewTitle').textContent = TITLES[name][0];
      $('viewSub').textContent = TITLES[name][1];
      $('backBtn').classList.add('hidden');
    }
    if (name === 'chats') loadRequests();
    if (name === 'people') loadUsers();
    if (name === 'rooms' || name === 'games') loadRooms();
  }
  document.querySelectorAll('.nav-btn').forEach((b) => b.addEventListener('click', () => {
    if (b.dataset.view === 'chat' && state.view === 'chat' && state.channel !== 'lobby') openLobby();
    else showView(b.dataset.view);
  }));
  $('backBtn').addEventListener('click', () => {
    if (state.view === 'games' && state.game) closeGame();
    else if (state.channelInfo.kind === 'dm') showView('chats');
    else if (state.channelInfo.kind === 'room' && state.channelInfo.room?.kind === 'game') showView('games');
    else if (state.channelInfo.kind === 'room') showView('rooms');
    else openLobby();
  });

  async function enterCabin() {
    $('gate').classList.add('hidden');
    $('cabin').classList.remove('hidden');
    try {
      const me = await api('/api/me');
      applyMe(me);
    } catch {
      return;
    }
    connectSocket();
    await openLobby();
    loadUsers();
    loadRequests();
    loadRooms();
  }

  function applyMe(me) {
    state.user = me.user;
    state.cabin = me.cabin;
    state.hidden = new Set(me.hidden);
    state.blocks = me.blocks;
    $('meName').textContent = me.user.displayName;
    $('meAvatar').textContent = initials(me.user.displayName);
    $('meSeat').textContent = `Seat ${me.user.seat} · only you can see this`;
    $('meMeta').textContent = `Flight ${me.user.flight}`;
    $('openToChat').checked = me.user.openToChat;
    $('dnd').checked = me.user.dnd;
    renderCabinBanners();
    renderMute(me.user.mutedUntil);
    renderBlocked();
  }

  function renderCabinBanners() {
    const a = state.cabin.announcement;
    $('announcement').classList.toggle('hidden', !a);
    if (a) {
      $('announcement').className = `announcement ${a.level}`;
      $('announcement').replaceChildren(el('strong', {}, a.level === 'safety' ? '⚠️ Crew safety notice' : '📣 Crew announcement'), el('span', {}, a.text));
    }
    $('quietBanner').classList.toggle('hidden', !state.cabin.quietMode);
  }

  let muteTimer = null;
  function renderMute(until) {
    clearTimeout(muteTimer);
    const on = until && until > Date.now();
    $('muteBanner').classList.toggle('hidden', !on);
    if (on) {
      $('muteBanner').textContent = `🔇 You are muted until ${fmtTime(until)}.`;
      muteTimer = setTimeout(() => renderMute(0), until - Date.now());
    }
  }

  function signOut(message) {
    localStorage.removeItem(TOKEN_KEY);
    if (state.socket) state.socket.disconnect();
    if (message) sessionStorage.setItem('ft_msg', message);
    location.reload();
  }

  $('logoutBtn').addEventListener('click', async () => {
    if (!(await confirmDialog('Sign out?', 'You can sign back in by scanning your boarding pass again.', 'Sign out'))) return;
    await api('/api/auth/logout', { body: {} }).catch(() => {});
    signOut();
  });

  async function saveSettings() {
    try {
      const data = await api('/api/me/settings', { body: { openToChat: $('openToChat').checked, dnd: $('dnd').checked } });
      state.user = Object.assign(state.user, data.user);
      toast('Saved');
    } catch (err) {
      toast(err.message, 'error');
    }
  }
  $('openToChat').addEventListener('change', saveSettings);
  $('dnd').addEventListener('change', saveSettings);

  // ---------------------------------------------------------------------------
  // Socket
  // ---------------------------------------------------------------------------
  let usersTimer = null;
  function connectSocket() {
    if (state.socket) state.socket.disconnect();
    const s = io({ auth: { token: state.token }, reconnectionDelayMax: 4000 });
    state.socket = s;
    const setConn = (ok, text) => {
      $('conn').classList.toggle('off', !ok);
      $('conn').querySelector('em').textContent = text;
    };
    s.on('connect', () => {
      setConn(true, 'Cabin server');
      reloadChannel();
    });
    s.on('disconnect', () => setConn(false, 'Reconnecting…'));
    s.on('connect_error', (err) => {
      setConn(false, 'Offline');
      if (err && err.message === 'Unauthorized') signOut('Your session ended. Please scan your boarding pass again.');
    });
    s.on('session:replaced', (i) => signOut(i.reason));
    s.on('session:removed', (i) => signOut(i.reason));

    s.on('users:dirty', () => {
      clearTimeout(usersTimer);
      // Jitter so 300 phones don't all hit the server in the same millisecond.
      usersTimer = setTimeout(() => {
        if (state.view === 'people') loadUsers();
        else state.usersStale = true;
      }, 200 + Math.random() * 1200);
    });
    s.on('hidden:update', (ids) => {
      state.hidden = new Set(ids);
      reloadChannel();
      loadUsers();
    });
    s.on('requests:update', loadRequests);
    s.on('notify', (n) => toast(n.text, n.kind === 'error' ? 'error' : 'info'));
    s.on('moderation', (m) => {
      toast(m.text, 'warn', 7000);
      state.user.mutedUntil = m.mutedUntil;
      renderMute(m.mutedUntil);
    });
    s.on('cabin:update', (c) => {
      const wasQuiet = state.cabin.quietMode;
      state.cabin = c;
      renderCabinBanners();
      if (c.quietMode && !wasQuiet) toast('Cabin crew paused chat', 'warn', 6000);
    });
    s.on('chat:message', (m) => {
      if (m.channel === state.channel) {
        appendMessage(m);
        $('typing').textContent = '';
      } else if (m.channel.startsWith('dm:') && m.sender && m.sender.id !== state.user.id) {
        toast(`New message from ${m.sender.displayName}`);
      }
    });
    s.on('chat:typing', (p) => {
      if (p.channel !== state.channel || state.hidden.has(p.user.id)) return;
      $('typing').textContent = p.typing ? `${p.user.displayName} is typing…` : '';
    });
    s.on('files:new', (f) => {
      if (f.channel === state.channel) loadFiles();
    });
    s.on('rooms:update', (room) => {
      const i = state.rooms.findIndex((r) => r.id === room.id);
      if (i >= 0) state.rooms[i] = room;
      else state.rooms.unshift(room);
      if (state.game && state.game.room.id === room.id) {
        state.game.room = room;
        renderGame();
      }
      if (state.channelInfo.room && state.channelInfo.room.id === room.id) {
        state.channelInfo.room = room;
        renderRoomBar();
      }
      renderRooms();
    });
    s.on('rooms:removed', (id) => {
      state.rooms = state.rooms.filter((r) => r.id !== id);
      state.myRooms.delete(id);
      renderRooms();
    });
    s.on('rooms:kicked', ({ roomId }) => {
      state.myRooms.delete(roomId);
      toast('The host removed you from the room', 'warn');
      if (state.game && state.game.room.id === roomId) closeGame();
      if (state.channel === `room:${roomId}`) openLobby();
    });
    s.on('game:state', ({ roomId, state: gs }) => {
      if (state.game && state.game.room.id === roomId) {
        state.game.state = gs;
        renderGame();
      }
    });
    s.on('watch:state', ({ roomId, state: ws }) => {
      if (state.channelInfo.room && state.channelInfo.room.id === roomId) applyWatch(ws);
    });
  }

  // ---------------------------------------------------------------------------
  // Chat
  // ---------------------------------------------------------------------------
  async function openChannel(channel, info) {
    state.channel = channel;
    state.channelInfo = info;
    $('piiTip').classList.add('hidden');
    $('typing').textContent = '';
    showView('chat');
    renderRoomBar();
    renderWatch();
    await reloadChannel();
  }

  function openLobby() {
    return openChannel('lobby', { kind: 'lobby' });
  }

  function renderChatHeader() {
    const i = state.channelInfo;
    $('backBtn').classList.toggle('hidden', i.kind === 'lobby');
    if (i.kind === 'lobby') {
      $('viewTitle').textContent = 'Cabin chat';
      $('viewSub').textContent = 'Everyone on this flight';
    } else if (i.kind === 'dm') {
      $('viewTitle').textContent = i.user.displayName;
      $('viewSub').textContent = `Private chat · ${i.user.zone}`;
    } else {
      $('viewTitle').textContent = i.room.name;
      $('viewSub').textContent = `Room ${i.room.id} · ${i.room.members.length} inside`;
    }
  }

  async function reloadChannel() {
    if (!state.user) return;
    const channel = state.channel;
    try {
      const data = await api(`/api/messages?channel=${encodeURIComponent(channel)}`);
      if (channel !== state.channel) return;
      $('messages').replaceChildren();
      data.messages.forEach(appendMessage);
      if (!data.messages.length) $('messages').append(el('p', { class: 'empty' }, channel === 'lobby' ? 'No messages yet. Say hello to the cabin 👋' : 'No messages yet.'));
      loadFiles();
    } catch (err) {
      if (channel !== 'lobby') {
        toast(err.message, 'error');
        openLobby();
      }
    }
  }

  function appendMessage(m) {
    if (m.sender && state.hidden.has(m.sender.id)) return;
    const box = $('messages');
    box.querySelector('.empty')?.remove();
    const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 120;
    if (m.kind !== 'user') {
      box.append(el('div', { class: `sys ${m.kind}` }, m.kind === 'announcement' ? '📣 ' : '', m.content, el('time', {}, fmtTime(m.createdAt))));
    } else {
      const mine = m.sender && m.sender.id === state.user.id;
      const meta = el('time', {}, fmtTime(m.createdAt), m.filtered ? ' · filtered' : '', m.shielded ? ' · details hidden' : '');
      const bubble = el('div', { class: `bubble${mine ? ' mine' : ''}` },
        mine ? null : el('b', {}, m.sender.displayName, m.sender.verified === 'barcode' ? el('span', { class: 'tick', title: 'Boarding pass barcode verified' }, ' ✓') : null),
        el('span', { class: 'text' }, m.content),
        meta);
      if (!mine) {
        bubble.append(el('button', { class: 'more', type: 'button', title: 'Report or block', onclick: () => openReport(m.sender, m.id) }, '⋯'));
      }
      box.append(bubble);
    }
    if (nearBottom) box.scrollTop = box.scrollHeight;
  }

  $('composer').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = $('messageInput');
    const content = input.value.trim();
    if (!content || !state.socket) return;
    state.socket.emit('chat:message', { channel: state.channel, content }, (res) => {
      if (!res || !res.ok) {
        toast(res?.error || 'Could not send', 'error');
        input.value = content;
        return;
      }
      if (res.warning) {
        $('piiTip').textContent = `🛡️ ${res.warning}`;
        $('piiTip').classList.remove('hidden');
      }
    });
    input.value = '';
  });

  let lastTyping = 0;
  $('messageInput').addEventListener('input', () => {
    if (state.socket && Date.now() - lastTyping > 1200) {
      lastTyping = Date.now();
      state.socket.emit('chat:typing', { channel: state.channel });
    }
  });

  // ---------------------------------------------------------------------------
  // Files
  // ---------------------------------------------------------------------------
  async function loadFiles() {
    try {
      const { files } = await api(`/api/files?channel=${encodeURIComponent(state.channel)}`);
      const box = $('filesList');
      box.replaceChildren();
      $('filesBox').querySelector('summary').textContent = `Files in this chat (${files.length})`;
      for (const f of files) {
        box.append(el('div', { class: 'card' },
          el('div', {}, el('h3', {}, f.filename), el('p', {}, `${fmtSize(f.size)} · ${f.sender ? f.sender.displayName : 'passenger'} · ${fmtTime(f.createdAt)}`)),
          el('div', { class: 'actions' }, button('Download', () => downloadFile(f)))));
      }
    } catch { /* ignore */ }
  }

  async function downloadFile(f) {
    try {
      const res = await fetch(`/api/files/${f.id}/download`, { headers: { 'x-session-token': state.token } });
      if (!res.ok) throw new Error('Download failed');
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = el('a', { href: url, download: f.filename });
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  $('attachInput').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    const channel = state.channel;
    $('fileProgress').textContent = `Uploading ${file.name}…`;
    try {
      if (file.size > 4 * 1024 * 1024) await uploadChunked(file, channel);
      else {
        const body = new FormData();
        body.append('channel', channel);
        body.append('file', file);
        await api('/api/files', { body });
      }
      $('fileProgress').textContent = `Shared ${file.name}`;
      $('filesBox').open = true;
      loadFiles();
    } catch (err) {
      $('fileProgress').textContent = '';
      toast(err.message, 'error');
    }
  });

  /** Chunked + resumable: each 1 MB chunk is retried up to 4 times if the Wi-Fi drops. */
  async function uploadChunked(file, channel) {
    const init = await api('/api/files/chunk/init', { body: { channel, filename: file.name, size: file.size, mime: file.type } });
    for (let index = 0; index < init.totalChunks; index += 1) {
      const blob = file.slice(index * init.chunkSize, (index + 1) * init.chunkSize);
      for (let attempt = 0; ; attempt += 1) {
        try {
          const body = new FormData();
          body.append('uploadId', init.uploadId);
          body.append('index', String(index));
          body.append('chunk', blob, `c${index}`);
          await api('/api/files/chunk', { body });
          break;
        } catch (err) {
          if (attempt >= 3) throw err;
          await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
        }
      }
      $('fileProgress').textContent = `Uploading ${file.name} — ${Math.round(((index + 1) / init.totalChunks) * 100)}%`;
    }
    await api('/api/files/chunk/complete', { body: { uploadId: init.uploadId } });
  }

  // ---------------------------------------------------------------------------
  // Passengers, requests, block, report
  // ---------------------------------------------------------------------------
  async function loadUsers() {
    try {
      const { users } = await api('/api/users');
      state.users = users;
      state.usersStale = false;
      renderPeople();
    } catch { /* ignore */ }
  }

  function contactFor(userId) {
    return state.requests.contacts.find((c) => c.user.id === userId);
  }

  function renderPeople() {
    const box = $('peopleList');
    box.replaceChildren();
    const list = state.users.filter((u) => !state.hidden.has(u.id));
    if (!list.length) {
      box.append(el('div', { class: 'card' }, el('div', {}, el('h3', {}, 'No discoverable passengers yet'), el('p', {}, 'People appear here when they turn on "Discoverable".'))));
      return;
    }
    for (const u of list) {
      const contact = contactFor(u.id);
      const outgoing = state.requests.outgoing.find((r) => r.user.id === u.id);
      const actions = el('div', { class: 'actions' });
      if (contact) actions.append(button('Message', () => openDm(contact), 'primary small'));
      else if (outgoing) actions.append(el('span', { class: 'chip' }, 'Requested'));
      else if (u.openToChat && !u.dnd) actions.append(button('Request chat', () => requestChat(u), 'primary small'));
      actions.append(button('Block', () => blockUser(u)), button('Report', () => openReport(u)));
      box.append(el('div', { class: 'card' },
        el('div', { class: 'who' },
          el('div', { class: `avatar sm${u.online ? ' on' : ''}` }, initials(u.displayName)),
          el('div', {},
            el('h3', {}, u.displayName, u.verified === 'barcode' ? el('span', { class: 'tick', title: 'Boarding pass barcode verified' }, ' ✓') : null),
            el('p', {}, `${u.zone} · ${u.online ? 'online' : 'away'}${u.dnd ? ' · do not disturb' : ''}`))),
        actions));
    }
  }

  async function requestChat(u) {
    try {
      const r = await api('/api/requests', { body: { userId: u.id } });
      toast(r.status === 'accepted' ? `You can now chat with ${u.displayName}` : `Request sent to ${u.displayName}`);
      await loadRequests();
      renderPeople();
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  async function loadRequests() {
    if (!state.user) return;
    try {
      state.requests = await api('/api/requests');
    } catch {
      return;
    }
    const r = state.requests;
    $('reqBadge').classList.toggle('hidden', !r.incoming.length);
    $('reqBadge').textContent = r.incoming.length || '';

    const inc = $('incomingList');
    inc.replaceChildren();
    if (!r.incoming.length) inc.append(el('p', { class: 'empty' }, state.user.dnd ? 'Do not disturb is on — new requests are hidden.' : 'No new requests.'));
    for (const q of r.incoming) {
      inc.append(el('div', { class: 'card' },
        el('div', {}, el('h3', {}, q.user.displayName), el('p', {}, `${q.user.zone} wants to chat`)),
        el('div', { class: 'actions' },
          button('Accept', () => respond(q, true), 'primary small'),
          button('Decline', () => respond(q, false)),
          button('Block', () => blockUser(q.user)))));
    }

    const con = $('contactsList');
    con.replaceChildren();
    if (!r.contacts.length) con.append(el('p', { class: 'empty' }, 'No private chats yet. Find people under Passengers.'));
    for (const c of r.contacts) {
      con.append(el('div', { class: 'card clickable', onclick: (e) => { if (!e.target.closest('button')) openDm(c); } },
        el('div', { class: 'who' }, el('div', { class: `avatar sm${c.user.online ? ' on' : ''}` }, initials(c.user.displayName)),
          el('div', {}, el('h3', {}, c.user.displayName), el('p', {}, c.last ? `${c.last.mine ? 'You: ' : ''}${c.last.content}`.slice(0, 60) : 'Say hi 👋'))),
        el('div', { class: 'actions' },
          button('Open', () => openDm(c), 'primary small'),
          button('End chat', async () => {
            if (!(await confirmDialog('End this chat?', `${c.user.displayName} won't be able to message you unless you accept a new request.`, 'End chat'))) return;
            await api(`/api/requests/${c.id}/cancel`, { body: {} });
            if (state.channel === c.channel) openLobby();
            loadRequests();
          }))));
    }

    const out = $('outgoingList');
    out.replaceChildren();
    if (!r.outgoing.length) out.append(el('p', { class: 'empty' }, 'None.'));
    for (const q of r.outgoing) {
      out.append(el('div', { class: 'card' }, el('div', {}, el('h3', {}, q.user.displayName), el('p', {}, 'Waiting for them to accept')),
        el('div', { class: 'actions' }, button('Cancel', async () => { await api(`/api/requests/${q.id}/cancel`, { body: {} }); loadRequests(); }))));
    }
    if (state.view === 'people') renderPeople();
    // If the chat we have open was ended / blocked, leave it.
    if (state.channelInfo.kind === 'dm' && !r.contacts.some((c) => c.channel === state.channel)) {
      toast('This private chat has ended');
      openLobby();
    }
  }

  async function respond(q, accept) {
    try {
      await api(`/api/requests/${q.id}/respond`, { body: { accept } });
      await loadRequests();
      if (accept) {
        const c = contactFor(q.user.id);
        if (c) openDm(c);
      }
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  function openDm(contact) {
    openChannel(contact.channel, { kind: 'dm', user: contact.user });
  }

  async function blockUser(u) {
    if (!(await confirmDialog(`Block ${u.displayName}?`, 'You will stop seeing each other everywhere in FlightTalk. They are not notified.', 'Block'))) return;
    try {
      await api('/api/block', { body: { userId: u.id } });
      state.hidden.add(u.id);
      state.blocks.push({ id: u.id, displayName: u.displayName });
      renderBlocked();
      toast(`${u.displayName} is blocked`);
      loadUsers();
      reloadChannel();
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  function renderBlocked() {
    const box = $('blockedList');
    box.replaceChildren();
    if (!state.blocks.length) box.append(el('p', { class: 'empty' }, 'You have not blocked anyone.'));
    for (const b of state.blocks) {
      box.append(el('div', { class: 'card' }, el('div', {}, el('h3', {}, b.displayName)),
        el('div', { class: 'actions' }, button('Unblock', async () => {
          await api('/api/unblock', { body: { userId: b.id } });
          state.blocks = state.blocks.filter((x) => x.id !== b.id);
          renderBlocked();
        }))));
    }
  }

  function openReport(u, messageId) {
    state.reportTarget = { user: u, messageId: messageId || null };
    $('reportName').textContent = u.displayName;
    $('reportDetails').value = '';
    $('reportModal').classList.remove('hidden');
  }
  $('reportCancel').addEventListener('click', () => $('reportModal').classList.add('hidden'));
  $('reportForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const t = state.reportTarget;
    try {
      await api('/api/report', { body: { userId: t.user.id, reason: $('reportReason').value, details: $('reportDetails').value, messageId: t.messageId } });
      if ($('reportBlock').checked) {
        await api('/api/block', { body: { userId: t.user.id } });
        state.hidden.add(t.user.id);
        state.blocks.push({ id: t.user.id, displayName: t.user.displayName });
        renderBlocked();
        reloadChannel();
        loadUsers();
      }
      $('reportModal').classList.add('hidden');
      toast('Thanks. The cabin crew have been notified.');
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  // ---------------------------------------------------------------------------
  // Rooms
  // ---------------------------------------------------------------------------
  async function loadRooms() {
    try {
      const data = await api('/api/rooms');
      state.rooms = data.rooms;
      state.myRooms = new Set(data.mine);
      renderRooms();
    } catch { /* ignore */ }
  }

  function renderRooms() {
    const chatBox = $('roomsList');
    chatBox.replaceChildren();
    const chatRooms = state.rooms.filter((r) => r.kind !== 'game');
    if (!chatRooms.length) chatBox.append(el('p', { class: 'empty' }, 'No rooms yet. Create one above.'));
    for (const room of chatRooms) {
      const mine = state.myRooms.has(room.id);
      chatBox.append(el('div', { class: 'card' },
        el('div', {}, el('h3', {}, room.name, ' ', el('span', { class: 'chip' }, room.id)),
          el('p', {}, `${room.kind === 'watch' ? 'Watch together' : 'Chat'} · ${room.members.length}/${room.capacity}`)),
        el('div', { class: 'actions' }, button(mine ? 'Open' : 'Join', () => joinRoom(room.id), 'primary small'))));
    }

    const gameBox = $('gameLobby');
    gameBox.replaceChildren();
    const gameRooms = state.rooms.filter((r) => r.kind === 'game' && (!r.private || state.myRooms.has(r.id)));
    if (!gameRooms.length) gameBox.append(el('p', { class: 'empty' }, 'No game rooms open. Create one and other passengers can join.'));
    for (const room of gameRooms) {
      const mine = state.myRooms.has(room.id);
      const full = room.members.length >= room.capacity;
      gameBox.append(el('div', { class: 'card' },
        el('div', {}, el('h3', {}, room.name, ' ', el('span', { class: 'chip' }, room.private ? 'vs bot' : room.id)),
          el('p', {}, `${GAME_NAMES[room.gameType]} · ${room.members.map((m) => m.displayName).join(', ')}${room.bots ? ` + ${room.bots} bot` : ''} · ${room.inProgress ? 'in progress' : 'waiting'}`)),
        el('div', { class: 'actions' }, mine || !full ? button(mine ? 'Open' : 'Join', () => joinRoom(room.id), 'primary small') : el('span', { class: 'chip' }, 'Full'))));
    }
  }

  $('roomForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const data = await api('/api/rooms', { body: { name: $('roomName').value, kind: $('roomKind').value } });
      $('roomName').value = '';
      await joinRoom(data.room.id);
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  async function joinRoom(id) {
    try {
      const data = await api(`/api/rooms/${id}/join`, { body: {} });
      state.myRooms.add(id);
      if (data.room.kind === 'game') {
        openGame(data.room, data.state);
      } else {
        await openChannel(`room:${id}`, { kind: 'room', room: data.room });
        if (data.playback) applyWatch(data.playback);
      }
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  async function leaveRoom(room) {
    await api(`/api/rooms/${room.id}/leave`, { body: {} }).catch(() => {});
    state.myRooms.delete(room.id);
    if (state.game && state.game.room.id === room.id) closeGame();
    if (state.channel === `room:${room.id}`) openLobby();
    loadRooms();
  }

  function renderRoomBar() {
    const bar = $('roomBar');
    const room = state.channelInfo.kind === 'room' ? state.channelInfo.room : null;
    bar.classList.toggle('hidden', !room);
    if (!room) return;
    bar.replaceChildren(
      el('div', { class: 'members' }, room.members.map((m) => el('span', { class: 'chip' }, m.displayName, m.id === room.hostId ? ' ★' : '',
        state.user.id === room.hostId && m.id !== state.user.id
          ? el('button', { class: 'x', type: 'button', title: 'Remove from room', onclick: () => api(`/api/rooms/${room.id}/kick`, { body: { userId: m.id } }).catch((err) => toast(err.message, 'error')) }, '×')
          : null))),
      el('div', { class: 'actions' }, button('Leave room', () => leaveRoom(room))));
    renderChatHeader();
  }

  // ---------------------------------------------------------------------------
  // Watch together
  // ---------------------------------------------------------------------------
  function renderWatch() {
    const panel = $('watchPanel');
    const room = state.channelInfo.kind === 'room' ? state.channelInfo.room : null;
    clearInterval(state.watch.heartbeat);
    if (!room || room.kind !== 'watch') {
      panel.classList.add('hidden');
      panel.replaceChildren();
      state.watch.video = null;
      return;
    }
    const isHost = room.hostId === state.user.id;
    const video = el('video', { controls: isHost, playsinline: true, class: 'watch-video' });
    const meta = el('p', { class: 'hint', id: 'watchMeta' }, isHost
      ? 'Pick a video file that every viewer has on their own device. Your play / pause / seek is mirrored to everyone.'
      : 'Pick your own copy of the video the host is playing. Playback follows the host automatically.');
    const picker = el('input', { type: 'file', accept: 'video/*,audio/*' });
    picker.addEventListener('change', () => {
      const f = picker.files[0];
      if (!f) return;
      video.src = URL.createObjectURL(f);
      video.dataset.name = f.name;
      if (!isHost && state.watch.last) setTimeout(() => applyWatch(state.watch.last), 300);
    });
    panel.replaceChildren(el('div', { class: 'row' }, el('strong', {}, '🎬 Watch together'), picker), video, meta);
    panel.classList.remove('hidden');
    state.watch.video = video;

    if (isHost) {
      const send = () => state.socket && state.socket.emit('watch:state', {
        roomId: room.id, playing: !video.paused, time: video.currentTime, duration: video.duration || 0, mediaName: video.dataset.name || ''
      });
      for (const ev of ['play', 'pause', 'seeked']) video.addEventListener(ev, send);
      state.watch.heartbeat = setInterval(() => { if (!video.paused) send(); }, 5000);
    }
  }

  function applyWatch(ws) {
    state.watch.last = ws;
    const v = state.watch.video;
    const meta = $('watchMeta');
    const mm = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
    if (meta) meta.textContent = `Host is ${ws.playing ? 'playing' : 'paused on'} ${ws.mediaName || 'a video'} at ${mm(ws.time)}`;
    if (!v || !v.src || (state.channelInfo.room && state.channelInfo.room.hostId === state.user.id)) return;
    const expected = ws.playing ? ws.time + (Date.now() - ws.at) / 1000 : ws.time;
    if (Math.abs(v.currentTime - expected) > 1) v.currentTime = expected; // correct drift > 1 s
    if (ws.playing && v.paused) v.play().catch(() => toast('Tap the video once to allow playback'));
    if (!ws.playing && !v.paused) v.pause();
  }

  // ---------------------------------------------------------------------------
  // Games
  // ---------------------------------------------------------------------------
  document.querySelectorAll('[data-solo]').forEach((b) => b.addEventListener('click', async () => {
    const gameType = b.dataset.solo;
    try {
      const data = await api('/api/rooms', {
        body: { kind: 'game', gameType, vsBot: true, botLevel: $('botLevel').value, bots: gameType === 'ludo' ? Number($('ludoBots').value) : 1 }
      });
      state.myRooms.add(data.room.id);
      openGame(data.room, data.state);
    } catch (err) {
      toast(err.message, 'error');
    }
  }));

  $('gameRoomForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const data = await api('/api/rooms', { body: { kind: 'game', gameType: $('gameType').value } });
      state.myRooms.add(data.room.id);
      openGame(data.room, data.state);
      toast(`Room ${data.room.id} created. Others can join from Games.`);
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  function openGame(room, gs) {
    state.game = { room, state: gs };
    showView('games');
    $('gameHome').classList.add('hidden');
    $('gamePanel').classList.remove('hidden');
    $('viewTitle').textContent = room.name;
    $('viewSub').textContent = room.private ? `${GAME_NAMES[room.gameType]} vs computer` : `Room ${room.id}`;
    $('backBtn').classList.remove('hidden');
    renderGame();
  }

  function closeGame() {
    state.game = null;
    clearInterval(state.clock);
    $('gamePanel').classList.add('hidden');
    $('gameHome').classList.remove('hidden');
    if (state.view === 'games') showView('games');
  }

  document.querySelector('[data-view="games"]').addEventListener('click', () => {
    if (state.game) closeGame();
  });
  function sendAction(action) {
    if (!state.game || !state.socket) return;
    state.socket.emit('game:action', { roomId: state.game.room.id, action }, (res) => {
      if (!res || !res.ok) toast(res?.error || 'Illegal move', 'error', 2200);
    });
  }

  function renderGame() {
    const g = state.game;
    if (!g) return;
    const { room } = g;
    const gs = g.state;
    const isHost = room.hostId === state.user.id;
    const playing = gs && gs.status === 'playing';
    $('gameTitle').textContent = GAME_NAMES[room.gameType] || 'Game';

    // Members + bots
    const members = $('gameMembers');
    members.replaceChildren(...room.members.map((m) => el('span', { class: 'chip' }, m.displayName, m.id === room.hostId ? ' ★' : '',
      isHost && !room.private && m.id !== state.user.id
        ? el('button', { class: 'x', type: 'button', title: 'Remove', onclick: () => api(`/api/rooms/${room.id}/kick`, { body: { userId: m.id } }).catch((e) => toast(e.message, 'error')) }, '×')
        : null)));
    for (let i = 0; i < (room.bots || 0); i += 1) members.append(el('span', { class: 'chip bot' }, `🤖 Bot ${i + 1}`));

    // Actions
    const actions = $('gameActions');
    actions.replaceChildren();
    if (!playing && isHost) {
      if (!room.private) {
        const max = room.gameType === 'ludo' ? 4 : 2;
        if (room.members.length + room.bots < max) actions.append(button('+ Bot', () => api(`/api/rooms/${room.id}/bots`, { body: { bots: room.bots + 1 } }).catch((e) => toast(e.message, 'error'))));
        if (room.bots > 0) actions.append(button('− Bot', () => api(`/api/rooms/${room.id}/bots`, { body: { bots: room.bots - 1 } })));
      }
      actions.append(button(gs ? 'Play again' : 'Start game', async () => {
        try {
          const data = await api(`/api/rooms/${room.id}/start`, { body: {} });
          g.state = data.state;
          renderGame();
        } catch (err) {
          toast(err.message, 'error');
        }
      }, 'primary small'));
    }
    if (!room.private) actions.append(button('Room chat', () => openChannel(`room:${room.id}`, { kind: 'room', room })));
    if (playing && gs.players.some((p) => p.id === state.user.id && !p.out)) {
      actions.append(button('Forfeit', async () => {
        if (await confirmDialog('Forfeit this game?', 'The other players will continue without you.', 'Forfeit')) state.socket.emit('game:forfeit', { roomId: room.id });
      }));
    }
    actions.append(button('Leave', () => leaveRoom(room)));

    // Status
    const status = $('gameStatus');
    const board = $('gameBoard');
    board.replaceChildren();
    $('gameLog').textContent = '';
    clearInterval(state.clock);
    if (!gs) {
      status.textContent = isHost
        ? `Waiting for players. Share room code ${room.id}, or add a bot, then press Start.`
        : 'Waiting for the host to start the game…';
      return;
    }
    const me = gs.players.find((p) => p.id === state.user.id);
    const cur = gs.players[gs.turn];
    const myTurn = playing && cur && cur.id === state.user.id;
    if (!playing) {
      status.textContent = gs.draw ? "It's a draw." : gs.winner === state.user.id ? '🏆 You won!' : `${nameOfUser(gs.winner)} won.`;
    } else {
      const you = me ? (me.mark ? `You are ${me.mark === 'R' ? '🔴' : me.mark === 'Y' ? '🟡' : me.mark}` : `You are ${me.color}`) : 'Spectating';
      const turn = myTurn ? 'Your turn' : `${nameOfUser(cur.id)}'s turn${cur.bot ? ' (thinking…)' : ''}`;
      status.textContent = `${you} · ${turn}`;
      if (gs.turnDeadline) {
        const tick = () => {
          const s = Math.max(0, Math.ceil((gs.turnDeadline - Date.now()) / 1000));
          status.textContent = `${you} · ${turn} · ${s}s`;
        };
        tick();
        state.clock = setInterval(tick, 500);
      }
    }
    if (gs.log && gs.log.length) $('gameLog').textContent = gs.log.slice(0, 3).join(' · ');

    if (gs.type === 'tictactoe') renderTtt(board, gs, myTurn);
    else if (gs.type === 'connectfour') renderC4(board, gs, myTurn);
    else renderLudo(board, gs, myTurn);
  }

  function renderTtt(board, gs, myTurn) {
    const grid = el('div', { class: 'board-ttt' });
    gs.board.forEach((v, i) => {
      const last = gs.lastMove && gs.lastMove.cell === i;
      grid.append(el('button', { class: `cell ${v ? v.toLowerCase() : ''}${last ? ' last' : ''}`, type: 'button', disabled: !myTurn || v !== null, onclick: () => sendAction({ cell: i }) }, v || ''));
    });
    board.append(grid);
  }

  function renderC4(board, gs, myTurn) {
    const grid = el('div', { class: 'board-c4' });
    for (let c = 0; c < 7; c += 1) {
      const col = el('button', { class: 'c4-col', type: 'button', disabled: !myTurn || gs.board[0][c] !== null, onclick: () => sendAction({ col: c }), 'aria-label': `Column ${c + 1}` });
      for (let r = 0; r < 6; r += 1) {
        const v = gs.board[r][c];
        const last = gs.lastMove && gs.lastMove.row === r && gs.lastMove.col === c;
        col.append(el('span', { class: `disc ${v || ''}${last ? ' last' : ''}` }));
      }
      grid.append(col);
    }
    board.append(grid);
  }

  const DICE = ['', '⚀', '⚁', '⚂', '⚃', '⚄', '⚅'];
  function renderLudo(board, gs, myTurn) {
    const wrap = el('div', { class: 'ludo-wrap' });
    window.FTLudo.render(wrap, gs, state.user.id, (piece) => sendAction({ kind: 'move', piece }));
    const cur = gs.players[gs.turn];
    const shown = gs.dice || (gs.lastMove && gs.lastMove.roll);
    const side = el('div', { class: 'ludo-side' },
      el('div', { class: `dice ${cur ? cur.color : ''}` }, shown ? DICE[shown] : '🎲'),
      myTurn && !gs.rolled ? button('Roll dice', () => sendAction({ kind: 'roll' }), 'primary') : null,
      myTurn && gs.rolled ? el('p', { class: 'hint' }, 'Tap a glowing piece to move it') : null,
      el('div', { class: 'ludo-legend' }, gs.players.map((p, i) => el('div', { class: `leg ${p.color}${i === gs.turn ? ' turn' : ''}${p.out ? ' out' : ''}` },
        el('i', {}), `${nameOfUser(p.id)} · ${p.pieces.filter((x) => x === 56).length}/4 home`))),
      el('p', { class: 'hint' }, 'Roll 6 to leave the yard. 6, a capture or reaching home = roll again. ★ squares are safe.'));
    board.append(el('div', { class: 'ludo-layout' }, wrap, side));
  }

  // ---------------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------------
  async function boot() {
    const msg = sessionStorage.getItem('ft_msg');
    if (msg) {
      sessionStorage.removeItem('ft_msg');
      setStatus(msg, 'error');
    }
    await loadCabinInfo();
    if (!window.FTScanner.canLiveScan()) $('liveBtn').classList.add('hidden');
    if (!state.token) return;
    try {
      const me = await api('/api/me');
      state.user = me.user;
      enterCabin();
    } catch {
      localStorage.removeItem(TOKEN_KEY);
      state.token = '';
    }
  }

  boot();
}
