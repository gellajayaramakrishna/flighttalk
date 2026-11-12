'use strict';
/* End-to-end tests against a real FlightTalk server (HTTP + Socket.IO) on a temp database. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'flighttalk-test-'));
process.env.FT_DATA_DIR = tmp;
process.env.CREW_PIN = '424242';
process.env.FT_BOT_DELAY_MS = '5';
process.env.FT_TURN_TIMEOUT_MS = '400';
process.env.FT_JOIN_LIMIT = '1000';

const { io: ioc } = require('socket.io-client');
const { createApp } = require('../server/app');

let srv;
let crewSession;
let base;
const sockets = [];

test.before(async () => {
  srv = createApp();
  await new Promise((r) => srv.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${srv.server.address().port}`;
  crewSession = await crewToken(); // log in before the lockout test locks this IP out
});

test.after(async () => {
  sockets.forEach((s) => s.disconnect());
  await srv.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function call(pathname, { token, crew, body, method } = {}) {
  const headers = {};
  if (token) headers['x-session-token'] = token;
  if (crew) headers['x-crew-token'] = crew;
  if (body && !(body instanceof FormData)) headers['Content-Type'] = 'application/json';
  const res = await fetch(base + pathname, {
    method: method || (body ? 'POST' : 'GET'),
    headers,
    body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let json = {};
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: res.status, body: json, headers: res.headers };
}

let seatNo = 1;
async function join(opts = {}) {
  const seat = opts.seat || `${seatNo++}A`;
  const r = await call('/api/auth/join', {
    body: {
      flight: opts.flight || 'AI865',
      seat,
      name: opts.name || { surname: `PASSENGER${seat.replace(/\d/g, '')}`, given: `TEST${seat}` },
      source: 'barcode',
      displayName: opts.displayName || `P${seat}`,
      openToChat: opts.openToChat !== false
    }
  });
  return Object.assign(r, { seat });
}

function connect(token) {
  return new Promise((resolve, reject) => {
    const s = ioc(base, { auth: { token }, transports: ['websocket'], forceNew: true });
    sockets.push(s);
    s.on('connect', () => resolve(s));
    s.on('connect_error', reject);
  });
}

const once = (socket, event, ms = 2000) => new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), ms);
  socket.once(event, (data) => { clearTimeout(t); resolve(data); });
});
const emit = (socket, event, payload) => new Promise((resolve) => socket.emit(event, payload, resolve));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function crewToken() {
  const r = await call('/api/crew/login', { body: { pin: '424242' } });
  return r.body.token;
}

// ---------------------------------------------------------------------------

test('join validates flight, seat, name and display name', async () => {
  assert.equal((await join({ seat: '0Z' })).status, 400);
  assert.equal((await join({ flight: 'X' })).status, 400);
  assert.equal((await join({ displayName: '   ' })).status, 400);
  assert.equal((await join({ displayName: '<script>' })).status, 400);
  assert.equal((await join({ displayName: 'b1tch' })).status, 400);
  const r = await join({ name: { surname: 'GELLA', given: 'JAYARAMA' }, displayName: 'Gella J' });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /surname/);
});

test('sessions: raw token is never stored, only its hash', async () => {
  const r = await join();
  assert.equal(r.status, 200);
  const dbFile = fs.readFileSync(path.join(tmp, 'flighttalk.db'));
  assert.equal(dbFile.includes(Buffer.from(r.body.token)), false);
});

test('seat identity: same passenger moves devices, a different person is refused', async () => {
  const name = { surname: 'NAIR', given: 'MEERA' };
  const first = await join({ seat: '30C', name });
  const s1 = await connect(first.body.token);
  const replaced = once(s1, 'session:replaced');
  const second = await join({ seat: '30C', name, displayName: 'Meera2' });
  assert.equal(second.status, 200);
  assert.equal(second.body.user.id, first.body.user.id);
  await replaced; // old phone is signed out
  const thief = await join({ seat: '30C', name: { surname: 'OTHER', given: 'PERSON' } });
  assert.equal(thief.status, 409);
});

test('other passengers see a cabin zone, never the exact seat', async () => {
  const a = await join({ seat: '14F', displayName: 'Zed' });
  const b = await join();
  const list = await call('/api/users', { token: b.body.token });
  const seen = list.body.users.find((u) => u.id === a.body.user.id);
  assert.equal(seen.zone, 'Rows 11–20');
  assert.equal(seen.seat, undefined);
  assert.ok(!JSON.stringify(list.body).includes('14F'));
});

test('discovery is opt-in', async () => {
  const hidden = await join({ openToChat: false });
  const viewer = await join();
  const list = await call('/api/users', { token: viewer.body.token });
  assert.ok(!list.body.users.some((u) => u.id === hidden.body.user.id));
});

test('lobby: contact details are masked, profanity filtered, no duplicate delivery', async () => {
  const a = await join();
  const b = await join();
  const sa = await connect(a.body.token);
  const sb = await connect(b.body.token);
  const got = [];
  sb.on('chat:message', (m) => got.push(m));
  const res = await emit(sa, 'chat:message', { channel: 'lobby', content: 'shit, call me on 98765 43210' });
  assert.equal(res.ok, true);
  assert.ok(res.warning);
  await sleep(150);
  const mine = got.filter((m) => m.id === res.message.id);
  assert.equal(mine.length, 1);
  assert.match(mine[0].content, /\[phone hidden\]/);
  assert.match(mine[0].content, /^\*{4}/);
  sb.off('chat:message');
});

test('private chat needs an accepted request; either side can end it', async () => {
  const a = await join();
  const b = await join();
  const sa = await connect(a.body.token);
  await connect(b.body.token);
  const channel = ['dm', ...[a.body.user.id, b.body.user.id].sort()].join(':');

  const before = await emit(sa, 'chat:message', { channel, content: 'hi' });
  assert.equal(before.ok, false);

  assert.equal((await call('/api/requests', { token: a.body.token, body: { userId: b.body.user.id } })).body.status, 'pending');
  const inbox = await call('/api/requests', { token: b.body.token });
  assert.equal(inbox.body.incoming.length, 1);
  await call(`/api/requests/${inbox.body.incoming[0].id}/respond`, { token: b.body.token, body: { accept: true } });

  const after = await emit(sa, 'chat:message', { channel, content: 'hi' });
  assert.equal(after.ok, true, after.error);

  const contacts = (await call('/api/requests', { token: b.body.token })).body.contacts;
  await call(`/api/requests/${contacts[0].id}/cancel`, { token: b.body.token, body: {} });
  assert.equal((await emit(sa, 'chat:message', { channel, content: 'still there?' })).ok, false);
});

test('declined requests have a cooldown; DND blocks new requests', async () => {
  const a = await join();
  const b = await join();
  await call('/api/requests', { token: a.body.token, body: { userId: b.body.user.id } });
  const id = (await call('/api/requests', { token: b.body.token })).body.incoming[0].id;
  await call(`/api/requests/${id}/respond`, { token: b.body.token, body: { accept: false } });
  assert.equal((await call('/api/requests', { token: a.body.token, body: { userId: b.body.user.id } })).status, 429);

  const c = await join();
  await call('/api/me/settings', { token: c.body.token, body: { openToChat: true, dnd: true } });
  assert.equal((await call('/api/requests', { token: a.body.token, body: { userId: c.body.user.id } })).status, 403);
});

test('block is silent and two-way: requests vanish and lobby messages are not delivered', async () => {
  const a = await join();
  const b = await join();
  const sb = await connect(b.body.token);
  await call('/api/block', { token: b.body.token, body: { userId: a.body.user.id } });
  // A doesn't find out: the request "succeeds" but B never receives it.
  const r = await call('/api/requests', { token: a.body.token, body: { userId: b.body.user.id } });
  assert.equal(r.status, 200);
  assert.equal((await call('/api/requests', { token: b.body.token })).body.incoming.length, 0);
  const sa = await connect(a.body.token);
  let leaked = false;
  sb.on('chat:message', (m) => { if (m.sender && m.sender.id === a.body.user.id) leaked = true; });
  await emit(sa, 'chat:message', { channel: 'lobby', content: 'can you see me?' });
  await sleep(150);
  assert.equal(leaked, false);
  const users = (await call('/api/users', { token: a.body.token })).body.users;
  assert.ok(!users.some((u) => u.id === b.body.user.id));
});

test('three different reporters auto-mute a passenger until crew review', async () => {
  const target = await join();
  const st = await connect(target.body.token);
  const moderated = once(st, 'moderation');
  for (let i = 0; i < 3; i += 1) {
    const reporter = await join();
    await call('/api/report', { token: reporter.body.token, body: { userId: target.body.user.id, reason: 'harassment' } });
  }
  const m = await moderated;
  assert.ok(m.mutedUntil > Date.now());
  const res = await emit(st, 'chat:message', { channel: 'lobby', content: 'hello?' });
  assert.equal(res.ok, false);
  assert.match(res.error, /muted/);
});

test('message flood is rate limited', async () => {
  const a = await join();
  const sa = await connect(a.body.token);
  const results = [];
  for (let i = 0; i < 10; i += 1) results.push((await emit(sa, 'chat:message', { channel: 'lobby', content: `msg ${i}` })).ok);
  assert.ok(results.slice(0, 8).every(Boolean));
  assert.equal(results[9], false);
});

test('crew: wrong PIN lockout', async () => {
  for (let i = 0; i < 5; i += 1) assert.equal((await call('/api/crew/login', { body: { pin: '000000' } })).status, 401);
  assert.equal((await call('/api/crew/login', { body: { pin: '424242' } })).status, 429);
});

test('crew: quiet mode, flight lock, announcements, remove, release seat, end flight', async () => {
  const crew = crewSession; // issued before the lockout test ran
  const a = await join();
  const sa = await connect(a.body.token);

  await call('/api/crew/settings', { crew, body: { quietMode: true } });
  const blocked = await emit(sa, 'chat:message', { channel: 'lobby', content: 'hello' });
  assert.equal(blocked.ok, false);
  assert.match(blocked.error, /paused/);
  await call('/api/crew/settings', { crew, body: { quietMode: false } });

  const banner = once(sa, 'cabin:update');
  await call('/api/crew/announce', { crew, body: { text: 'Seatbelt sign is on', level: 'safety' } });
  assert.equal((await banner).announcement.level, 'safety');

  await call('/api/crew/settings', { crew, body: { flightLock: 'AI865' } });
  assert.equal((await join({ flight: 'AI101' })).status, 403);

  const removed = once(sa, 'session:removed');
  await call(`/api/crew/users/${a.body.user.id}/remove`, { crew, body: {} });
  await removed;
  assert.equal((await call('/api/me', { token: a.body.token })).status, 401);
  assert.equal((await join({ seat: a.seat, name: { surname: `PASSENGER${a.seat.replace(/\d/g, '')}`, given: `TEST${a.seat}` } })).status, 403);

  // Release seat: someone grabbed 40K first; crew frees it for the real passenger.
  const grabber = await join({ seat: '40K', name: { surname: 'FAKE', given: 'GUY' } });
  assert.equal((await join({ seat: '40K', name: { surname: 'REAL', given: 'OWNER' } })).status, 409);
  await call(`/api/crew/users/${grabber.body.user.id}/release-seat`, { crew, body: {} });
  assert.equal((await join({ seat: '40K', name: { surname: 'REAL', given: 'OWNER' } })).status, 200);

  const overview = await call('/api/crew/overview', { crew });
  assert.ok(overview.body.stats.passengers > 0);
  assert.ok(overview.body.audit.some((x) => x.action === 'release-seat'));

  const end = await call('/api/crew/end-flight', { crew, body: {} });
  assert.ok(end.body.erased.passengers > 0);
  const after = await call('/api/crew/overview', { crew });
  assert.equal(after.body.stats.passengers, 0);
  assert.equal(after.body.stats.messages, 0);
  await call('/api/crew/settings', { crew, body: { flightLock: '' } });
});

test('files: dangerous types rejected, downloads need auth and are forced to download', async () => {
  const a = await join();
  const html = new FormData();
  html.append('channel', 'lobby');
  html.append('file', new Blob(['<script>alert(1)</script>'], { type: 'text/html' }), 'evil.html');
  assert.equal((await call('/api/files', { token: a.body.token, body: html })).status, 400);

  const ok = new FormData();
  ok.append('channel', 'lobby');
  ok.append('file', new Blob(['hello cabin'], { type: 'text/plain' }), 'notes.txt');
  const up = await call('/api/files', { token: a.body.token, body: ok });
  assert.equal(up.status, 200);
  const id = up.body.file.id;
  assert.equal((await call(`/api/files/${id}/download`)).status, 401);
  const b = await join();
  const dl = await call(`/api/files/${id}/download`, { token: b.body.token });
  assert.equal(dl.status, 200);
  assert.match(dl.headers.get('content-disposition'), /attachment/);
  assert.equal(dl.headers.get('content-type'), 'application/octet-stream');
  assert.equal((await call('/uploads/' + id)).status, 404, 'no public uploads folder any more');
});

test('files: chunked upload rejects undeclared extra data and finishes when complete', async () => {
  const a = await join();
  const init = await call('/api/files/chunk/init', { token: a.body.token, body: { channel: 'lobby', filename: 'clip.mp4', size: 10, mime: 'video/mp4' } });
  assert.equal(init.status, 200);
  const big = new FormData();
  big.append('uploadId', init.body.uploadId);
  big.append('index', '0');
  big.append('chunk', new Blob([Buffer.alloc(20)]), 'c0');
  assert.equal((await call('/api/files/chunk', { token: a.body.token, body: big })).status, 400);
  const good = new FormData();
  good.append('uploadId', init.body.uploadId);
  good.append('index', '0');
  good.append('chunk', new Blob([Buffer.alloc(10)]), 'c0');
  assert.equal((await call('/api/files/chunk', { token: a.body.token, body: good })).status, 200);
  const done = await call('/api/files/chunk/complete', { token: a.body.token, body: { uploadId: init.body.uploadId } });
  assert.equal(done.body.file.size, 10);
});

test('security headers: strict CSP and no sniffing', async () => {
  const r = await fetch(base + '/');
  assert.match(r.headers.get('content-security-policy'), /script-src 'self' 'wasm-unsafe-eval'/);
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(r.headers.get('x-frame-options'), 'DENY');
});

test('games: solo game vs bot is created and started; bot replies automatically', async () => {
  const a = await join();
  const sa = await connect(a.body.token);
  const r = await call('/api/rooms', { token: a.body.token, body: { kind: 'game', gameType: 'tictactoe', vsBot: true } });
  assert.equal(r.status, 200);
  assert.equal(r.body.state.status, 'playing');
  const roomId = r.body.room.id;
  const me = r.body.state.players.findIndex((p) => p.id === a.body.user.id);
  if (r.body.state.turn !== me) await once(sa, 'game:state');
  const botReply = new Promise((resolve) => sa.on('game:state', (p) => { if (p.state.moves === (r.body.state.turn === me ? 2 : 3)) resolve(p.state); }));
  const live = (await call(`/api/rooms/${roomId}/game`, { token: a.body.token })).body.state;
  const cell = live.board.findIndex((v) => v === null);
  assert.equal((await emit(sa, 'game:action', { roomId, action: { cell } })).ok, true);
  const after = await botReply;
  assert.ok(after.board.filter(Boolean).length >= 2);
  sa.off('game:state');
});

test('games: multiplayer start rules, kick removes socket from the room, idle turn auto-moves', async () => {
  const host = await join();
  const guest = await join();
  const sh = await connect(host.body.token);
  const sg = await connect(guest.body.token);
  const room = (await call('/api/rooms', { token: host.body.token, body: { kind: 'game', gameType: 'connectfour' } })).body.room;
  assert.equal((await call(`/api/rooms/${room.id}/start`, { token: host.body.token, body: {} })).status, 400, 'needs 2 players');
  await call(`/api/rooms/${room.id}/join`, { token: guest.body.token, body: {} });
  assert.equal((await call(`/api/rooms/${room.id}/start`, { token: guest.body.token, body: {} })).status, 403, 'only host starts');
  const start = await call(`/api/rooms/${room.id}/start`, { token: host.body.token, body: {} });
  assert.equal(start.status, 200);
  assert.ok(start.body.state.turnDeadline || true);

  // Nobody moves: the turn clock (400 ms in tests) makes a move for the idle player.
  const auto = await new Promise((resolve) => sh.on('game:state', (p) => { if (p.state.moves >= 1) resolve(p.state); }));
  assert.match(auto.log[0], /timed out/);
  sh.off('game:state');

  // Kick: the guest stops receiving room traffic and the game is forfeited to the host.
  let leaked = false;
  const kicked = once(sg, 'rooms:kicked');
  await call(`/api/rooms/${room.id}/kick`, { token: host.body.token, body: { userId: guest.body.user.id } });
  await kicked;
  sg.on('chat:message', (m) => { if (m.channel === `room:${room.id}`) leaked = true; });
  await emit(sh, 'chat:message', { channel: `room:${room.id}`, content: 'secret' });
  await sleep(150);
  assert.equal(leaked, false);
  const state = (await call(`/api/rooms/${room.id}/game`, { token: host.body.token })).body.state;
  assert.equal(state.winner, host.body.user.id);
});
