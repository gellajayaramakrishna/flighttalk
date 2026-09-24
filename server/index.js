'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');
const multer = require('multer');
function uuid() {
  return crypto.randomUUID();
}
const config = require('./config');
const db = require('./db');
const { filterText, RateLimiter } = require('./safety');
const games = require('./games');
const APP_MODE = 'airline';

fs.mkdirSync(config.DATA_DIR, { recursive: true });
fs.mkdirSync(config.UPLOAD_DIR, { recursive: true });
fs.mkdirSync(config.CHUNK_DIR, { recursive: true });

const app = express();
const certPath = path.join(config.DATA_DIR, 'cert.pem');
const keyPath = path.join(config.DATA_DIR, 'key.pem');
const useHttps = fs.existsSync(certPath) && fs.existsSync(keyPath);
const server = useHttps
  ? require('https').createServer({ key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) }, app)
  : http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 2 * 1024 * 1024 });
const limiter = new RateLimiter(config.RATE_WINDOW_MS, config.RATE_MAX_MESSAGES);
const typing = new Map();

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, config.UPLOAD_DIR),
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname).slice(0, 12);
      cb(null, `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${ext}`);
    }
  }),
  limits: { fileSize: config.MAX_FILE_SIZE },
  fileFilter: (_req, file, cb) => {
    const blocked = /\.(exe|bat|cmd|sh|js|msi|apk)$/i.test(file.originalname);
    if (blocked) return cb(new Error('File type not allowed'));
    cb(null, true);
  }
});

app.use(express.json({ limit: '2mb' }));
app.use('/uploads', express.static(config.UPLOAD_DIR));
app.use('/vendor/tesseract', express.static(path.join(__dirname, '..', 'node_modules', 'tesseract.js')));
app.use('/vendor/tesseract-core', express.static(path.join(__dirname, '..', 'node_modules', 'tesseract.js-core')));
app.use('/vendor/tessdata', express.static(path.join(__dirname, '..', 'public', 'vendor', 'tessdata')));

const publicDir = path.join(__dirname, '..', 'public');
app.use(express.static(publicDir));

function now() {
  return Date.now();
}

function publicUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    mode: row.mode,
    displayName: row.display_name,
    fullName: row.mode === 'general' ? row.full_name : undefined,
    seat: row.seat || null,
    flight: row.flight || null,
    openToChat: Boolean(row.open_to_chat),
    dnd: Boolean(row.dnd)
  };
}

function getUser(id) {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
}

function getUserByToken(token) {
  const session = db.prepare('SELECT * FROM sessions WHERE token = ?').get(token);
  if (!session) return null;
  return { session, user: getUser(session.user_id) };
}

function requireAuth(req, res, next) {
  const token = String(req.headers['x-session-token'] || '');
  const found = getUserByToken(token);
  if (!found || !found.user) return res.status(401).json({ error: 'Unauthorized' });
  req.session = found.session;
  req.user = found.user;
  next();
}

function displayNameFrom(fullName, mode) {
  const cleaned = String(fullName || '').trim().replace(/\s+/g, ' ');
  if (!cleaned) return 'Guest';
  if (mode === 'airline') return cleaned.slice(0, 3);
  return cleaned.slice(0, 24);
}

function isBlocked(a, b) {
  const row = db.prepare(
    'SELECT 1 FROM blocks WHERE (blocker_id = ? AND blocked_id = ?) OR (blocker_id = ? AND blocked_id = ?)'
  ).get(a, b, b, a);
  return Boolean(row);
}

function lobbyChannel(mode) {
  return `lobby:${mode === 'airline' ? 'airline' : 'general'}`;
}

function dmChannel(a, b) {
  return ['dm', ...[a, b].sort()].join(':');
}

function roomChannel(id) {
  return `room:${id}`;
}

function canMessage(sender, channel) {
  if (channel === lobbyChannel(sender.mode)) return true;
  if (channel.startsWith('dm:')) {
    const parts = channel.split(':');
    const ids = [parts[1], parts[2]];
    if (!ids.includes(sender.id)) return false;
    const other = ids.find((id) => id !== sender.id);
    if (isBlocked(sender.id, other)) return false;
    const otherUser = getUser(other);
    if (!otherUser || otherUser.mode !== sender.mode) return false;
    if (otherUser.dnd && !db.prepare(
      'SELECT 1 FROM messages WHERE channel = ? LIMIT 1'
    ).get(channel)) return false;
    return true;
  }
  if (channel.startsWith('room:')) {
    const roomId = channel.slice(5);
    const room = db.prepare('SELECT mode FROM rooms WHERE id = ?').get(roomId);
    if (!room || room.mode !== sender.mode) return false;
    return Boolean(db.prepare(
      'SELECT 1 FROM room_members WHERE room_id = ? AND user_id = ?'
    ).get(roomId, sender.id));
  }
  return false;
}

function serializeMessage(row) {
  const user = getUser(row.sender_id);
  return {
    id: row.id,
    channel: row.channel,
    content: row.content,
    filtered: Boolean(row.filtered),
    createdAt: row.created_at,
    sender: publicUser(user)
  };
}

function serializeRoom(row, members) {
  return {
    id: row.id,
    name: row.name,
    hostId: row.host_id,
    kind: row.kind,
    gameType: row.game_type,
    capacity: row.capacity,
    mode: row.mode,
    createdAt: row.created_at,
    members: members.map(publicUser)
  };
}

function roomMembers(roomId) {
  const ids = db.prepare('SELECT user_id FROM room_members WHERE room_id = ?').all(roomId).map((r) => r.user_id);
  return ids.map(getUser).filter(Boolean);
}

function usersInMode(mode) {
  return db.prepare('SELECT * FROM users WHERE mode = ? ORDER BY last_seen DESC').all(mode).map(publicUser);
}

function emitPresence(mode) {
  io.to(`mode:${mode}`).emit('presence:update', usersInMode(mode));
}

function emitRoomUpdate(room) {
  io.to(`mode:${room.mode || 'general'}`).emit('rooms:update', serializeRoom(room, roomMembers(room.id)));
}

function cleanupEmptyRooms() {
  const rooms = db.prepare('SELECT id FROM rooms').all();
  for (const room of rooms) {
    const count = db.prepare('SELECT COUNT(*) AS n FROM room_members WHERE room_id = ?').get(room.id).n;
    if (count === 0) {
      db.prepare('DELETE FROM game_states WHERE room_id = ?').run(room.id);
      db.prepare('DELETE FROM rooms WHERE id = ?').run(room.id);
      io.to('mode:general').emit('rooms:removed', room.id);
      io.to('mode:airline').emit('rooms:removed', room.id);
    }
  }
}

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, name: 'FlightTalk', offline: true });
});

app.post('/api/auth/join', (req, res) => {
  const mode = APP_MODE;
  const fullName = String(req.body.fullName || req.body.displayName || '').trim().slice(0, 80);
  if (mode === 'airline' && !fullName) return res.status(400).json({ error: 'Display name required' });
  if (mode === 'general' && fullName.length < 2) return res.status(400).json({ error: 'Name required' });

  const requestedDisplayName = String(req.body.displayName || '').trim().toUpperCase();
  if (mode === 'airline' && (requestedDisplayName.length < 1 || requestedDisplayName.length > 32)) {
    return res.status(400).json({ error: 'Display name must be 1–32 characters' });
  }

  let seat = null;
  let flight = null;
  if (mode === 'airline') {
    seat = String(req.body.seat || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
    flight = String(req.body.flight || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
    if (!/^[0-9]{1,3}[A-K]$/.test(seat)) return res.status(400).json({ error: 'Invalid seat' });
    if (flight.length < 2) return res.status(400).json({ error: 'Invalid flight' });
  }

  const display = mode === 'airline' ? requestedDisplayName : displayNameFrom(fullName, mode);
  const ts = now();
  let user;

  if (mode === 'airline') {
    const existing = db.prepare(
      'SELECT * FROM users WHERE mode = ? AND flight = ? AND seat = ?'
    ).get('airline', flight, seat);
    if (existing) {
      const samePerson = existing.full_name.toLowerCase() === fullName.toLowerCase();
      if (!samePerson) {
        return res.status(409).json({
          error: 'Seat already claimed by another passenger for this flight'
        });
      }
      user = existing;
      db.prepare('UPDATE users SET last_seen = ?, display_name = ? WHERE id = ?')
        .run(ts, display, user.id);
      user = getUser(user.id);
    }
  }

  if (!user && mode === 'general') {
    const existing = db.prepare(
      'SELECT * FROM users WHERE mode = ? AND lower(full_name) = lower(?)'
    ).get('general', fullName);
    if (existing) user = existing;
  }

  if (!user) {
    user = {
      id: uuid(),
      mode,
      display_name: display,
      full_name: fullName,
      seat,
      flight,
      open_to_chat: 0,
      dnd: 0,
      created_at: ts,
      last_seen: ts
    };
    db.prepare(`
      INSERT INTO users (id, mode, display_name, full_name, seat, flight, open_to_chat, dnd, created_at, last_seen)
      VALUES (@id, @mode, @display_name, @full_name, @seat, @flight, @open_to_chat, @dnd, @created_at, @last_seen)
    `).run(user);
  }

  const token = crypto.randomBytes(24).toString('hex');
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
  db.prepare('INSERT INTO sessions (token, user_id, socket_id, created_at) VALUES (?, ?, NULL, ?)')
    .run(token, user.id, ts);

  res.json({ token, user: publicUser(user) });
});

app.get('/api/me', requireAuth, (req, res) => {
  res.json({ user: publicUser(req.user) });
});

app.post('/api/me/settings', requireAuth, (req, res) => {
  const openToChat = req.body.openToChat ? 1 : 0;
  const dnd = req.body.dnd ? 1 : 0;
  db.prepare('UPDATE users SET open_to_chat = ?, dnd = ?, last_seen = ? WHERE id = ?')
    .run(openToChat, dnd, now(), req.user.id);
  const user = getUser(req.user.id);
  emitPresence(user.mode);
  res.json({ user: publicUser(user) });
});

app.get('/api/users', requireAuth, (req, res) => {
  const users = usersInMode(req.user.mode).filter((u) => u.id !== req.user.id);
  res.json({ users });
});

app.get('/api/messages', requireAuth, (req, res) => {
  const channel = String(req.query.channel || lobbyChannel(req.user.mode));
  if (!canMessage(req.user, channel)) return res.status(403).json({ error: 'Forbidden' });
  const rows = db.prepare(
    'SELECT * FROM messages WHERE channel = ? ORDER BY created_at DESC LIMIT 80'
  ).all(channel).reverse();
  res.json({ messages: rows.map(serializeMessage) });
});

app.get('/api/rooms', requireAuth, (req, res) => {
  const rooms = db.prepare('SELECT * FROM rooms WHERE mode = ? ORDER BY created_at DESC').all(req.user.mode)
    .map((row) => serializeRoom(row, roomMembers(row.id)));
  res.json({ rooms });
});

app.post('/api/rooms', requireAuth, (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 32) || 'Room';
  const kind = req.body.kind === 'game' ? 'game' : 'chat';
  const gameType = ['tictactoe', 'connectfour', 'ludo'].includes(req.body.gameType)
    ? req.body.gameType
    : (kind === 'game' ? 'tictactoe' : null);
  const capacity = Math.min(Number(req.body.capacity) || (gameType ? games.maxPlayers(gameType) : config.ROOM_CAPACITY_DEFAULT), 12);
  const id = uuid().slice(0, 8).toUpperCase();
  const ts = now();
  db.prepare(`
    INSERT INTO rooms (id, name, host_id, kind, game_type, capacity, created_at, mode)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, name, req.user.id, kind, gameType, capacity, ts, req.user.mode);
  db.prepare('INSERT INTO room_members (room_id, user_id, joined_at) VALUES (?, ?, ?)')
    .run(id, req.user.id, ts);
  const row = db.prepare('SELECT * FROM rooms WHERE id = ?').get(id);
  const room = serializeRoom(row, roomMembers(id));
  io.to(`mode:${req.user.mode}`).emit('rooms:update', room);
  res.json({ room });
});

app.post('/api/rooms/:id/join', requireAuth, (req, res) => {
  const room = db.prepare('SELECT * FROM rooms WHERE id = ?').get(String(req.params.id).toUpperCase());
  if (!room) return res.status(404).json({ error: 'Room not found' });
  if (room.mode !== req.user.mode) return res.status(403).json({ error: 'Wrong app' });
  const count = db.prepare('SELECT COUNT(*) AS n FROM room_members WHERE room_id = ?').get(room.id).n;
  const already = db.prepare('SELECT 1 FROM room_members WHERE room_id = ? AND user_id = ?').get(room.id, req.user.id);
  if (!already && count >= room.capacity) return res.status(400).json({ error: 'Room full' });
  if (!already) {
    db.prepare('INSERT INTO room_members (room_id, user_id, joined_at) VALUES (?, ?, ?)')
      .run(room.id, req.user.id, now());
  }
  const updated = serializeRoom(room, roomMembers(room.id));
  io.to(`mode:${req.user.mode}`).emit('rooms:update', updated);
  res.json({ room: updated });
});

app.post('/api/rooms/:id/leave', requireAuth, (req, res) => {
  const roomId = String(req.params.id).toUpperCase();
  db.prepare('DELETE FROM room_members WHERE room_id = ? AND user_id = ?').run(roomId, req.user.id);
  const room = db.prepare('SELECT * FROM rooms WHERE id = ?').get(roomId);
  if (room && room.host_id === req.user.id) {
    const nextHost = db.prepare('SELECT user_id FROM room_members WHERE room_id = ? LIMIT 1').get(roomId);
    if (nextHost) db.prepare('UPDATE rooms SET host_id = ? WHERE id = ?').run(nextHost.user_id, roomId);
  }
  cleanupEmptyRooms();
  const left = db.prepare('SELECT * FROM rooms WHERE id = ?').get(roomId);
  if (left) io.to(`mode:${req.user.mode}`).emit('rooms:update', serializeRoom(left, roomMembers(roomId)));
  else io.to(`mode:${req.user.mode}`).emit('rooms:removed', roomId);
  res.json({ ok: true });
});

app.post('/api/rooms/:id/kick', requireAuth, (req, res) => {
  const roomId = String(req.params.id).toUpperCase();
  const room = db.prepare('SELECT * FROM rooms WHERE id = ?').get(roomId);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  if (room.mode !== req.user.mode) return res.status(403).json({ error: 'Wrong app' });
  if (room.host_id !== req.user.id) return res.status(403).json({ error: 'Only host can kick' });
  const targetId = String(req.body.userId || '');
  if (targetId === req.user.id) return res.status(400).json({ error: 'Cannot kick yourself' });
  db.prepare('DELETE FROM room_members WHERE room_id = ? AND user_id = ?').run(roomId, targetId);
  const updated = serializeRoom(room, roomMembers(roomId));
  io.to(roomChannel(roomId)).emit('rooms:kicked', { roomId, userId: targetId });
  io.to(`mode:${req.user.mode}`).emit('rooms:update', updated);
  res.json({ room: updated });
});

app.post('/api/rooms/:id/start', requireAuth, (req, res) => {
  const roomId = String(req.params.id).toUpperCase();
  const room = db.prepare('SELECT * FROM rooms WHERE id = ?').get(roomId);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  if (room.mode !== req.user.mode) return res.status(403).json({ error: 'Wrong app' });
  if (room.host_id !== req.user.id) return res.status(403).json({ error: 'Only host can start' });
  if (room.kind !== 'game' || !room.game_type) return res.status(400).json({ error: 'Not a game room' });
  const members = roomMembers(roomId);
  if (members.length < games.minPlayers(room.game_type)) {
    return res.status(400).json({ error: 'Not enough players' });
  }
  const state = games.createGame(room.game_type, members.map((m) => m.id));
  db.prepare(`
    INSERT INTO game_states (room_id, type, state_json, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(room_id) DO UPDATE SET type = excluded.type, state_json = excluded.state_json, updated_at = excluded.updated_at
  `).run(roomId, state.type, JSON.stringify(state), now());
  io.to(roomChannel(roomId)).emit('game:state', { roomId, state });
  res.json({ state });
});

app.get('/api/files', requireAuth, (req, res) => {
  const channel = String(req.query.channel || lobbyChannel(req.user.mode));
  if (!canMessage(req.user, channel)) return res.status(403).json({ error: 'Forbidden' });
  const rows = db.prepare(
    'SELECT * FROM files WHERE channel = ? ORDER BY created_at DESC LIMIT 40'
  ).all(channel);
  res.json({
    files: rows.map((row) => ({
      id: row.id,
      filename: row.filename,
      size: row.size,
      mime: row.mime,
      url: `/uploads/${path.basename(row.storage_path)}`,
      createdAt: row.created_at,
      sender: publicUser(getUser(row.sender_id))
    }))
  });
});

app.post('/api/files', requireAuth, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  const channel = String(req.body.channel || lobbyChannel(req.user.mode));
  if (!canMessage(req.user, channel)) {
    fs.unlink(req.file.path, () => {});
    return res.status(403).json({ error: 'Forbidden' });
  }
  const id = uuid();
  db.prepare(`
    INSERT INTO files (id, sender_id, channel, filename, size, mime, storage_path, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, req.user.id, channel, req.file.originalname, req.file.size, req.file.mimetype || 'application/octet-stream', req.file.path, now());
  const payload = {
    id,
    filename: req.file.originalname,
    size: req.file.size,
    mime: req.file.mimetype,
    url: `/uploads/${path.basename(req.file.path)}`,
    createdAt: now(),
    sender: publicUser(req.user),
    channel
  };
  io.to(channel).emit('files:new', payload);
  res.json({ file: payload });
});

const chunkSessions = new Map();

app.post('/api/files/chunk/init', requireAuth, (req, res) => {
  const channel = String(req.body.channel || lobbyChannel(req.user.mode));
  if (!canMessage(req.user, channel)) return res.status(403).json({ error: 'Forbidden' });
  const filename = String(req.body.filename || 'file').slice(0, 180);
  const size = Number(req.body.size || 0);
  const mime = String(req.body.mime || 'application/octet-stream').slice(0, 120);
  if (!size || size > 500 * 1024 * 1024) return res.status(400).json({ error: 'Invalid size' });
  if (/\.(exe|bat|cmd|sh|js|msi|apk)$/i.test(filename)) return res.status(400).json({ error: 'File type not allowed' });
  const uploadId = uuid();
  const dir = path.join(config.CHUNK_DIR, uploadId);
  fs.mkdirSync(dir, { recursive: true });
  chunkSessions.set(uploadId, {
    userId: req.user.id,
    channel,
    filename,
    size,
    mime,
    dir,
    received: 0,
    createdAt: now()
  });
  res.json({ uploadId, chunkSize: config.MAX_CHUNK_SIZE });
});

const chunkUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.MAX_CHUNK_SIZE + 1024 }
});

app.post('/api/files/chunk', requireAuth, chunkUpload.single('chunk'), (req, res) => {
  const uploadId = String(req.body.uploadId || '');
  const session = chunkSessions.get(uploadId);
  if (!session || session.userId !== req.user.id) return res.status(404).json({ error: 'Unknown upload' });
  const index = Number(req.body.index);
  if (!Number.isInteger(index) || index < 0 || !req.file) return res.status(400).json({ error: 'Invalid chunk' });
  fs.writeFileSync(path.join(session.dir, String(index)), req.file.buffer);
  session.received += req.file.size;
  res.json({ ok: true, received: session.received });
});

app.post('/api/files/chunk/complete', requireAuth, (req, res) => {
  const uploadId = String(req.body.uploadId || '');
  const session = chunkSessions.get(uploadId);
  if (!session || session.userId !== req.user.id) return res.status(404).json({ error: 'Unknown upload' });
  const files = fs.readdirSync(session.dir).sort((a, b) => Number(a) - Number(b));
  const ext = path.extname(session.filename).slice(0, 12);
  const destName = `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${ext}`;
  const dest = path.join(config.UPLOAD_DIR, destName);
  const out = fs.createWriteStream(dest);
  out.on('finish', () => {
    for (const name of files) fs.unlinkSync(path.join(session.dir, name));
    fs.rm(session.dir, { recursive: true }, () => {});
    chunkSessions.delete(uploadId);
    const id = uuid();
    const size = fs.statSync(dest).size;
    db.prepare(`
      INSERT INTO files (id, sender_id, channel, filename, size, mime, storage_path, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, req.user.id, session.channel, session.filename, size, session.mime, dest, now());
    const payload = {
      id,
      filename: session.filename,
      size,
      mime: session.mime,
      url: `/uploads/${destName}`,
      createdAt: now(),
      sender: publicUser(req.user),
      channel: session.channel
    };
    io.to(session.channel).emit('files:new', payload);
    res.json({ file: payload });
  });
  out.on('error', (err) => res.status(500).json({ error: err.message }));
  for (const name of files) {
    out.write(fs.readFileSync(path.join(session.dir, name)));
  }
  out.end();
});

setInterval(() => {
  const cutoff = Date.now() - 30 * 60 * 1000;
  for (const [id, sess] of chunkSessions) {
    if (sess.createdAt < cutoff) {
      fs.rm(sess.dir, { recursive: true }, () => {});
      chunkSessions.delete(id);
    }
  }
}, 60_000).unref();

const playback = new Map();

app.post('/api/block', requireAuth, (req, res) => {
  const targetId = String(req.body.userId || '');
  if (!targetId || targetId === req.user.id) return res.status(400).json({ error: 'Invalid user' });
  db.prepare('INSERT OR IGNORE INTO blocks (blocker_id, blocked_id, created_at) VALUES (?, ?, ?)')
    .run(req.user.id, targetId, now());
  res.json({ ok: true });
});

app.post('/api/report', requireAuth, (req, res) => {
  const targetId = String(req.body.userId || '');
  const reason = ['harassment', 'spam', 'inappropriate', 'other'].includes(req.body.reason)
    ? req.body.reason
    : 'other';
  const details = String(req.body.details || '').slice(0, 280);
  if (!targetId) return res.status(400).json({ error: 'Invalid user' });
  const id = uuid();
  db.prepare(`
    INSERT INTO reports (id, reporter_id, target_id, reason, details, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, req.user.id, targetId, reason, details, now());
  res.json({ ok: true, id });
});

app.get('/api/reports', requireAuth, (req, res) => {
  const rows = db.prepare(
    'SELECT * FROM reports WHERE reporter_id = ? ORDER BY created_at DESC LIMIT 50'
  ).all(req.user.id);
  res.json({ reports: rows });
});

app.use((err, _req, res, _next) => {
  res.status(400).json({ error: err.message || 'Request failed' });
});

io.use((socket, next) => {
  const token = socket.handshake.auth?.token;
  const found = getUserByToken(token);
  if (!found || !found.user) return next(new Error('Unauthorized'));
  socket.user = found.user;
  socket.token = token;
  next();
});

io.on('connection', (socket) => {
  const user = socket.user;
  db.prepare('UPDATE sessions SET socket_id = ? WHERE token = ?').run(socket.id, socket.token);
  db.prepare('UPDATE users SET last_seen = ? WHERE id = ?').run(now(), user.id);

  const oldSockets = [...io.sockets.sockets.values()].filter((s) => s.id !== socket.id && s.user?.id === user.id);
  for (const old of oldSockets) {
    old.emit('session:replaced', { reason: 'Signed in on another device' });
    old.disconnect(true);
  }

  socket.join(lobbyChannel(user.mode));
  socket.join(`mode:${user.mode}`);
  socket.join(`user:${user.id}`);
  const memberships = db.prepare('SELECT room_id FROM room_members WHERE user_id = ?').all(user.id);
  for (const row of memberships) socket.join(roomChannel(row.room_id));
  emitPresence(user.mode);

  socket.on('chat:join', (channel) => {
    if (typeof channel !== 'string') return;
    if (!canMessage(getUser(user.id), channel)) return;
    socket.join(channel);
  });

  socket.on('chat:message', (payload, cb) => {
    try {
      const live = getUser(user.id);
      const channel = String(payload?.channel || lobbyChannel(live.mode));
      if (!canMessage(live, channel)) throw new Error('Cannot send to this channel');
      if (!limiter.allow(`${live.id}:${channel}`)) throw new Error('Slow down — rate limited');
      const raw = String(payload?.content || '').trim().slice(0, 500);
      if (!raw) throw new Error('Empty message');
      const { text, filtered } = filterText(raw);
      const row = {
        id: uuid(),
        channel,
        sender_id: live.id,
        content: text,
        filtered: filtered ? 1 : 0,
        created_at: now()
      };
      db.prepare(`
        INSERT INTO messages (id, channel, sender_id, content, filtered, created_at)
        VALUES (@id, @channel, @sender_id, @content, @filtered, @created_at)
      `).run(row);
      const message = serializeMessage(row);
      io.to(channel).emit('chat:message', message);
      if (channel.startsWith('dm:')) {
        const ids = channel.split(':').slice(1);
        ids.forEach((id) => io.to(`user:${id}`).emit('chat:message', message));
      }
      if (cb) cb({ ok: true, message });
    } catch (err) {
      if (cb) cb({ ok: false, error: err.message });
    }
  });

  socket.on('chat:typing', (payload) => {
    const live = getUser(user.id);
    const channel = String(payload?.channel || lobbyChannel(live.mode));
    if (!canMessage(live, channel)) return;
    const key = `${channel}:${live.id}`;
    clearTimeout(typing.get(key));
    socket.to(channel).emit('chat:typing', { channel, user: publicUser(live), typing: true });
    typing.set(key, setTimeout(() => {
      socket.to(channel).emit('chat:typing', { channel, user: publicUser(live), typing: false });
      typing.delete(key);
    }, 1600));
  });

  socket.on('watch:sync', (payload) => {
    const roomId = String(payload?.roomId || '').toUpperCase();
    const member = db.prepare('SELECT 1 FROM room_members WHERE room_id = ? AND user_id = ?').get(roomId, user.id);
    if (!member) return;
    const room = db.prepare('SELECT * FROM rooms WHERE id = ?').get(roomId);
    if (!room || room.host_id !== user.id) return;
    const state = {
      playing: Boolean(payload.playing),
      time: Number(payload.time) || 0,
      mediaName: String(payload.mediaName || '').slice(0, 120),
      at: now()
    };
    playback.set(roomId, state);
    socket.to(roomChannel(roomId)).emit('watch:sync', { roomId, state });
  });

  socket.on('game:action', (payload, cb) => {
    try {
      const roomId = String(payload?.roomId || '').toUpperCase();
      const room = db.prepare('SELECT * FROM rooms WHERE id = ?').get(roomId);
      if (!room) throw new Error('Room not found');
      const member = db.prepare('SELECT 1 FROM room_members WHERE room_id = ? AND user_id = ?').get(roomId, user.id);
      if (!member) throw new Error('Not in room');
      const stored = db.prepare('SELECT * FROM game_states WHERE room_id = ?').get(roomId);
      if (!stored) throw new Error('Game not started');
      const current = JSON.parse(stored.state_json);
      const next = games.applyAction(current, user.id, payload.action || {});
      db.prepare('UPDATE game_states SET state_json = ?, updated_at = ? WHERE room_id = ?')
        .run(JSON.stringify(next), now(), roomId);
      io.to(roomChannel(roomId)).emit('game:state', { roomId, state: next });
      if (cb) cb({ ok: true, state: next });
    } catch (err) {
      if (cb) cb({ ok: false, error: err.message });
    }
  });

  socket.on('disconnect', () => {
    db.prepare('UPDATE users SET last_seen = ? WHERE id = ?').run(now(), user.id);
    emitPresence(user.mode);
  });
});

server.listen(config.PORT, config.HOST, () => {
  const proto = useHttps ? 'https' : 'http';
  console.log(`FlightTalk listening on ${proto}://${config.HOST}:${config.PORT}`);
  if (!useHttps) {
    console.log('HTTP mode. For camera OCR on phones, put mkcert files at data/cert.pem and data/key.pem');
  }
});
