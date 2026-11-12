'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');
const multer = require('multer');

const config = require('./config');
const db = require('./db');
const games = require('./games');
const PassParse = require('../public/js/pass-parse');
const { filterText, containsProfanity, shieldPII, detectPII, RateLimiter, RepeatDetector } = require('./safety');

const LOBBY = 'lobby';
const now = () => Date.now();
const uuid = () => crypto.randomUUID();
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', false);

  const certPath = path.join(config.DATA_DIR, 'cert.pem');
  const keyPath = path.join(config.DATA_DIR, 'key.pem');
  const useHttps = fs.existsSync(certPath) && fs.existsSync(keyPath);
  const server = useHttps
    ? require('https').createServer({ key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) }, app)
    : http.createServer(app);
  const io = new Server(server, { maxHttpBufferSize: 64 * 1024, pingInterval: 20_000, pingTimeout: 20_000 });

  // ---------------------------------------------------------------------------
  // State that lives only in memory
  // ---------------------------------------------------------------------------
  const msgLimiter = new RateLimiter(config.RATE_WINDOW_MS, config.RATE_MAX_MESSAGES);
  const userLimiter = new RateLimiter(config.RATE_WINDOW_MS, config.RATE_MAX_MESSAGES * 2);
  const joinLimiter = new RateLimiter(60_000, config.JOIN_ATTEMPTS_PER_MIN);
  const actionLimiter = new RateLimiter(60_000, 30);
  const repeat = new RepeatDetector(3, 60_000);
  const crewTokens = new Map(); // token -> expiresAt
  const crewFails = new Map(); // ip -> { count, until }
  const online = new Map(); // userId -> number of connected sockets
  const typingTimers = new Map();
  const gameTimers = new Map();
  const playback = new Map();
  const chunkSessions = new Map();

  if (!db.setting.get('secret')) db.setting.set('secret', crypto.randomBytes(32).toString('hex'));
  if (config.FLIGHT && !db.setting.get('flightLock')) db.setting.set('flightLock', config.FLIGHT);

  const cabin = () => ({
    flightLock: db.setting.get('flightLock', ''),
    quietMode: Boolean(db.setting.get('quietMode', false)),
    announcement: db.setting.get('announcement', null)
  });

  function audit(actor, action, target, details) {
    db.prepare('INSERT INTO audit_log (actor, action, target, details, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(actor, action, target || null, details ? JSON.stringify(details) : null, now());
  }

  // ---------------------------------------------------------------------------
  // Security headers. Everything is same-origin: the app makes zero requests off the aircraft.
  // ---------------------------------------------------------------------------
  app.use((req, res, next) => {
    res.setHeader('Content-Security-Policy', [
      "default-src 'self'",
      "script-src 'self' 'wasm-unsafe-eval'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "media-src 'self' blob:",
      "connect-src 'self' ws: wss: data: blob:",
      "worker-src 'self' blob:",
      "object-src 'none'",
      "base-uri 'none'",
      "frame-ancestors 'none'",
      "form-action 'self'"
    ].join('; '));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Permissions-Policy', 'camera=(self), microphone=(), geolocation=(), payment=()');
    if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
    next();
  });

  app.use(express.json({ limit: '64kb' }));

  const nm = path.join(config.ROOT, 'node_modules');
  const longCache = { maxAge: '7d', immutable: true };
  app.use('/vendor/tesseract/dist', express.static(path.join(nm, 'tesseract.js', 'dist'), longCache));
  app.use('/vendor/tesseract-core', express.static(path.join(nm, 'tesseract.js-core'), longCache));
  app.use('/vendor/tessdata', express.static(path.join(config.ROOT, 'public', 'vendor', 'tessdata'), longCache));
  app.use('/vendor/zxing', express.static(path.join(nm, 'zxing-wasm', 'dist', 'iife', 'reader'), longCache));
  app.use('/vendor/zxing', express.static(path.join(nm, 'zxing-wasm', 'dist', 'reader'), longCache));
  app.use(express.static(path.join(config.ROOT, 'public'), { index: 'index.html' }));

  // ---------------------------------------------------------------------------
  // Users & sessions
  // ---------------------------------------------------------------------------
  const getUser = (id) => db.prepare('SELECT * FROM users WHERE id = ?').get(id);

  function seatZone(seat) {
    const row = Number(String(seat || '').replace(/\D/g, ''));
    if (!row) return 'Cabin';
    const start = Math.floor((row - 1) / 10) * 10 + 1;
    return `Rows ${start}–${start + 9}`;
  }

  /** What OTHER passengers can see. Exact seat is never shared: only a 10-row zone. */
  function publicUser(row) {
    if (!row) return null;
    return {
      id: row.id,
      displayName: row.display_name,
      zone: seatZone(row.seat),
      openToChat: Boolean(row.open_to_chat),
      dnd: Boolean(row.dnd),
      verified: row.verified_by,
      online: (online.get(row.id) || 0) > 0
    };
  }

  /** What the passenger sees about themselves. */
  function selfUser(row) {
    return Object.assign(publicUser(row), {
      seat: row.seat,
      flight: row.flight,
      mutedUntil: row.muted_until > now() ? row.muted_until : 0
    });
  }

  function findSession(token) {
    if (!token || typeof token !== 'string') return null;
    const session = db.prepare('SELECT * FROM sessions WHERE token_hash = ?').get(sha256(token));
    if (!session) return null;
    if (session.expires_at < now()) {
      db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(session.token_hash);
      return null;
    }
    const user = getUser(session.user_id);
    if (!user || user.removed) return null;
    return { session, user };
  }

  function requireAuth(req, res, next) {
    const found = findSession(String(req.headers['x-session-token'] || ''));
    if (!found) return res.status(401).json({ error: 'Session expired — please scan your boarding pass again' });
    req.user = found.user;
    next();
  }

  function hiddenIds(userId) {
    const rows = db.prepare('SELECT blocked_id AS id FROM blocks WHERE blocker_id = ? UNION SELECT blocker_id AS id FROM blocks WHERE blocked_id = ?')
      .all(userId, userId);
    return rows.map((r) => r.id);
  }

  function isBlocked(a, b) {
    return Boolean(db.prepare('SELECT 1 FROM blocks WHERE (blocker_id = ? AND blocked_id = ?) OR (blocker_id = ? AND blocked_id = ?)').get(a, b, b, a));
  }

  function acceptedRequest(a, b) {
    return db.prepare(`SELECT * FROM chat_requests WHERE status = 'accepted'
      AND ((from_id = ? AND to_id = ?) OR (from_id = ? AND to_id = ?))`).get(a, b, b, a);
  }

  const dmChannel = (a, b) => ['dm', ...[a, b].sort()].join(':');
  const roomChannel = (id) => `room:${id}`;
  const isMember = (roomId, userId) => Boolean(db.prepare('SELECT 1 FROM room_members WHERE room_id = ? AND user_id = ?').get(roomId, userId));

  function canRead(user, channel) {
    if (channel === LOBBY) return true;
    if (channel.startsWith('dm:')) {
      const [, a, b] = channel.split(':');
      if (a !== user.id && b !== user.id) return false;
      const other = a === user.id ? b : a;
      return !isBlocked(user.id, other) && Boolean(acceptedRequest(user.id, other));
    }
    if (channel.startsWith('room:')) return isMember(channel.slice(5), user.id);
    return false;
  }

  function sendBlockReason(user) {
    if (cabin().quietMode) return 'Chat is paused by the cabin crew. Please follow crew instructions.';
    if (user.muted_until > now()) return `You are muted until ${new Date(user.muted_until).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
    return null;
  }

  function kickSockets(userId, event, payload) {
    io.in(`user:${userId}`).emit(event, payload);
    io.in(`user:${userId}`).disconnectSockets(true);
  }

  // Tell clients the passenger list changed. Each client re-fetches its own filtered view.
  let usersDirtyTimer = null;
  function usersDirty() {
    if (usersDirtyTimer) return;
    usersDirtyTimer = setTimeout(() => {
      usersDirtyTimer = null;
      io.emit('users:dirty');
      io.to('crew').emit('crew:dirty');
    }, 250);
  }

  // ---------------------------------------------------------------------------
  // Public cabin info + onboarding
  // ---------------------------------------------------------------------------
  app.get('/api/health', (_req, res) => res.json({ ok: true, name: 'FlightTalk', offline: true }));

  app.get('/api/cabin', (_req, res) => {
    const c = cabin();
    res.json({ flightLock: c.flightLock, quietMode: c.quietMode, announcement: c.announcement });
  });

  app.post('/api/auth/join', (req, res) => {
    if (!joinLimiter.allow(`join:${req.socket.remoteAddress}`)) {
      return res.status(429).json({ error: 'Too many attempts. Wait a minute and try again.' });
    }
    const body = req.body || {};
    const flight = String(body.flight || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    const seat = PassParse.normalizeSeat(body.seat);
    const source = body.source === 'barcode' ? 'barcode' : 'ocr';
    const manualName = Boolean(body.manualName);
    const name = body.name && typeof body.name === 'object'
      ? { surname: String(body.name.surname || '').slice(0, 40), given: String(body.name.given || '').slice(0, 60) }
      : null;
    const key = PassParse.identityKey(name);
    const displayName = String(body.displayName || '').replace(/\s+/g, ' ').trim();
    const discoverable = body.openToChat ? 1 : 0;

    if (!/^[A-Z0-9]{2}\d{1,4}[A-Z]?$/.test(flight)) return res.status(400).json({ error: 'Flight number could not be read' });
    if (!seat) return res.status(400).json({ error: 'Seat number could not be read' });
    if (key.length < 2) return res.status(400).json({ error: 'Passenger name could not be read' });
    if (!/^[\p{L}\p{N} ._-]{1,20}$/u.test(displayName)) {
      return res.status(400).json({ error: 'Display name must be 1–20 letters, numbers, spaces, . _ -' });
    }
    if (containsProfanity(displayName)) return res.status(400).json({ error: 'Please choose a different display name' });
    const surnameLetters = String(name.surname || '').toUpperCase().replace(/[^A-Z]/g, '');
    if (surnameLetters.length >= 4 && displayName.toUpperCase().replace(/[^A-Z]/g, '').includes(surnameLetters)) {
      return res.status(400).json({ error: 'For your privacy, do not use your surname in your display name' });
    }

    const c = cabin();
    if (c.flightLock && flight !== c.flightLock) {
      return res.status(403).json({ error: `This boarding pass is for ${flight}. This cabin is ${c.flightLock}.` });
    }
    if (c.flightLock && source === 'barcode' && body.passDate) {
      const diff = Math.abs(new Date(`${body.passDate}T12:00:00Z`) - new Date(`${new Date().toISOString().slice(0, 10)}T12:00:00Z`));
      if (Number.isFinite(diff) && diff > 36 * 3600 * 1000) {
        return res.status(403).json({ error: `This boarding pass is dated ${body.passDate}, not today.` });
      }
    }

    // Raw name is never stored. Only a keyed hash, so a copied database reveals nothing.
    const identityHash = crypto.createHmac('sha256', db.setting.get('secret')).update(`${key}|${flight}|${seat}`).digest('hex');
    const verifiedBy = source === 'barcode' ? 'barcode' : (manualName ? 'ocr+manual' : 'ocr');
    const ts = now();
    let user = db.prepare('SELECT * FROM users WHERE flight = ? AND seat = ?').get(flight, seat);

    if (user) {
      if (user.removed) return res.status(403).json({ error: 'This seat was removed from FlightTalk by the cabin crew.' });
      if (user.identity_hash !== identityHash) {
        audit('system', 'seat-conflict', user.id, { flight, seat });
        io.to('crew').emit('crew:alert', { kind: 'seat-conflict', text: `Second boarding pass scanned for seat ${seat}` });
        return res.status(409).json({ error: 'This seat is already registered to another passenger. Please ask the cabin crew to check your boarding pass.' });
      }
      // Same passenger on a new device: move the session across.
      db.prepare('UPDATE users SET display_name = ?, verified_by = ?, last_seen = ? WHERE id = ?').run(displayName, verifiedBy, ts, user.id);
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
      kickSockets(user.id, 'session:replaced', { reason: 'You signed in on another device.' });
    } else {
      const id = uuid();
      db.prepare(`INSERT INTO users (id, display_name, identity_hash, seat, flight, verified_by, open_to_chat, dnd, created_at, last_seen)
        VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`).run(id, displayName, identityHash, seat, flight, verifiedBy, discoverable, ts, ts);
      audit('system', 'join', id, { seat, verifiedBy });
    }
    user = db.prepare('SELECT * FROM users WHERE flight = ? AND seat = ?').get(flight, seat);

    const token = crypto.randomBytes(32).toString('hex');
    db.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
      .run(sha256(token), user.id, ts, ts + config.SESSION_TTL_MS);
    usersDirty();
    res.json({ token, user: selfUser(user) });
  });

  app.post('/api/auth/logout', requireAuth, (req, res) => {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(String(req.headers['x-session-token'])));
    res.json({ ok: true });
  });

  app.get('/api/me', requireAuth, (req, res) => {
    const blocks = db.prepare('SELECT u.id, u.display_name FROM blocks b JOIN users u ON u.id = b.blocked_id WHERE b.blocker_id = ?').all(req.user.id);
    res.json({
      user: selfUser(req.user),
      cabin: cabin(),
      hidden: hiddenIds(req.user.id),
      blocks: blocks.map((b) => ({ id: b.id, displayName: b.display_name }))
    });
  });

  app.post('/api/me/settings', requireAuth, (req, res) => {
    const openToChat = req.body.openToChat ? 1 : 0;
    const dnd = req.body.dnd ? 1 : 0;
    db.prepare('UPDATE users SET open_to_chat = ?, dnd = ?, last_seen = ? WHERE id = ?').run(openToChat, dnd, now(), req.user.id);
    usersDirty();
    res.json({ user: selfUser(getUser(req.user.id)) });
  });

  // Opt-in discovery: you only see passengers who chose to be visible, plus your existing chats.
  app.get('/api/users', requireAuth, (req, res) => {
    const hidden = new Set(hiddenIds(req.user.id));
    const contactIds = new Set(db.prepare(`SELECT CASE WHEN from_id = ? THEN to_id ELSE from_id END AS id
      FROM chat_requests WHERE status IN ('accepted', 'pending') AND (from_id = ? OR to_id = ?)`).all(req.user.id, req.user.id, req.user.id).map((r) => r.id));
    const rows = db.prepare('SELECT * FROM users WHERE removed = 0 AND id != ? ORDER BY last_seen DESC LIMIT 500').all(req.user.id);
    const users = rows.filter((u) => !hidden.has(u.id) && (u.open_to_chat || contactIds.has(u.id))).map(publicUser);
    res.json({ users });
  });

  // ---------------------------------------------------------------------------
  // Consent-based private chat: request -> accept -> chat. Either side can end it.
  // ---------------------------------------------------------------------------
  function requestsFor(userId) {
    const rows = db.prepare(`SELECT * FROM chat_requests WHERE status IN ('pending','accepted') AND (from_id = ? OR to_id = ?) ORDER BY updated_at DESC`).all(userId, userId);
    const hidden = new Set(hiddenIds(userId));
    const out = { incoming: [], outgoing: [], contacts: [] };
    for (const r of rows) {
      const otherId = r.from_id === userId ? r.to_id : r.from_id;
      if (hidden.has(otherId)) continue;
      const other = getUser(otherId);
      if (!other || other.removed) continue;
      const item = { id: r.id, user: publicUser(other), createdAt: r.created_at };
      if (r.status === 'accepted') {
        const channel = dmChannel(userId, otherId);
        const last = db.prepare('SELECT content, created_at, sender_id FROM messages WHERE channel = ? ORDER BY created_at DESC LIMIT 1').get(channel);
        out.contacts.push(Object.assign(item, { channel, last: last ? { content: last.content, at: last.created_at, mine: last.sender_id === userId } : null }));
      } else if (r.to_id === userId) {
        if (!getUser(userId).dnd) out.incoming.push(item);
      } else out.outgoing.push(item);
    }
    return out;
  }

  const notifyRequests = (...ids) => ids.forEach((id) => io.to(`user:${id}`).emit('requests:update'));

  app.get('/api/requests', requireAuth, (req, res) => res.json(requestsFor(req.user.id)));

  app.post('/api/requests', requireAuth, (req, res) => {
    const me = req.user;
    const reason = sendBlockReason(me);
    if (reason) return res.status(403).json({ error: reason });
    const target = getUser(String(req.body.userId || ''));
    if (!target || target.removed || target.id === me.id) return res.status(404).json({ error: 'Passenger not found' });
    const iBlocked = db.prepare('SELECT 1 FROM blocks WHERE blocker_id = ? AND blocked_id = ?').get(me.id, target.id);
    if (iBlocked) return res.status(400).json({ error: 'Unblock this passenger first' });
    // Silent block: if they blocked me, pretend it worked and never deliver it.
    if (isBlocked(me.id, target.id)) return res.json({ ok: true, status: 'pending' });
    if (!target.open_to_chat) return res.status(403).json({ error: 'This passenger is not accepting chats' });
    if (target.dnd) return res.status(403).json({ error: 'This passenger has Do Not Disturb on' });

    const existing = db.prepare(`SELECT * FROM chat_requests WHERE ((from_id = ? AND to_id = ?) OR (from_id = ? AND to_id = ?))
      ORDER BY updated_at DESC LIMIT 1`).get(me.id, target.id, target.id, me.id);
    if (existing && existing.status === 'accepted') return res.json({ ok: true, status: 'accepted' });
    if (existing && existing.status === 'pending') {
      if (existing.to_id === me.id) {
        db.prepare("UPDATE chat_requests SET status = 'accepted', updated_at = ? WHERE id = ?").run(now(), existing.id);
        notifyRequests(me.id, target.id);
        return res.json({ ok: true, status: 'accepted' });
      }
      return res.json({ ok: true, status: 'pending' });
    }
    if (existing && existing.status === 'declined' && existing.from_id === me.id && now() - existing.updated_at < config.REQUEST_COOLDOWN_MS) {
      return res.status(429).json({ error: 'They declined recently. Please give them some space.' });
    }
    const pending = db.prepare("SELECT COUNT(*) AS n FROM chat_requests WHERE from_id = ? AND status = 'pending'").get(me.id).n;
    if (pending >= config.MAX_PENDING_REQUESTS) return res.status(429).json({ error: 'You have too many pending requests' });

    db.prepare("INSERT INTO chat_requests (id, from_id, to_id, status, created_at, updated_at) VALUES (?, ?, ?, 'pending', ?, ?)")
      .run(uuid(), me.id, target.id, now(), now());
    notifyRequests(me.id, target.id);
    io.to(`user:${target.id}`).emit('notify', { kind: 'request', text: `${me.display_name} wants to chat` });
    res.json({ ok: true, status: 'pending' });
  });

  app.post('/api/requests/:id/respond', requireAuth, (req, res) => {
    const r = db.prepare("SELECT * FROM chat_requests WHERE id = ? AND status = 'pending'").get(String(req.params.id));
    if (!r || r.to_id !== req.user.id) return res.status(404).json({ error: 'Request not found' });
    const status = req.body.accept ? 'accepted' : 'declined';
    db.prepare('UPDATE chat_requests SET status = ?, updated_at = ? WHERE id = ?').run(status, now(), r.id);
    notifyRequests(r.from_id, r.to_id);
    if (status === 'accepted') io.to(`user:${r.from_id}`).emit('notify', { kind: 'accepted', text: `${req.user.display_name} accepted your chat request` });
    res.json({ ok: true, status });
  });

  app.post('/api/requests/:id/cancel', requireAuth, (req, res) => {
    const r = db.prepare("SELECT * FROM chat_requests WHERE id = ? AND status IN ('pending','accepted')").get(String(req.params.id));
    if (!r || (r.from_id !== req.user.id && r.to_id !== req.user.id)) return res.status(404).json({ error: 'Not found' });
    db.prepare("UPDATE chat_requests SET status = 'ended', updated_at = ? WHERE id = ?").run(now(), r.id);
    notifyRequests(r.from_id, r.to_id);
    res.json({ ok: true });
  });

  // ---------------------------------------------------------------------------
  // Block & report
  // ---------------------------------------------------------------------------
  app.post('/api/block', requireAuth, (req, res) => {
    const target = getUser(String(req.body.userId || ''));
    if (!target || target.id === req.user.id) return res.status(400).json({ error: 'Invalid passenger' });
    db.prepare('INSERT OR IGNORE INTO blocks (blocker_id, blocked_id, created_at) VALUES (?, ?, ?)').run(req.user.id, target.id, now());
    db.prepare(`UPDATE chat_requests SET status = 'ended', updated_at = ? WHERE status IN ('pending','accepted')
      AND ((from_id = ? AND to_id = ?) OR (from_id = ? AND to_id = ?))`).run(now(), req.user.id, target.id, target.id, req.user.id);
    notifyRequests(req.user.id, target.id);
    io.to(`user:${req.user.id}`).emit('hidden:update', hiddenIds(req.user.id));
    io.to(`user:${target.id}`).emit('hidden:update', hiddenIds(target.id));
    usersDirty();
    res.json({ ok: true });
  });

  app.post('/api/unblock', requireAuth, (req, res) => {
    const targetId = String(req.body.userId || '');
    db.prepare('DELETE FROM blocks WHERE blocker_id = ? AND blocked_id = ?').run(req.user.id, targetId);
    io.to(`user:${req.user.id}`).emit('hidden:update', hiddenIds(req.user.id));
    io.to(`user:${targetId}`).emit('hidden:update', hiddenIds(targetId));
    usersDirty();
    res.json({ ok: true });
  });

  app.post('/api/report', requireAuth, (req, res) => {
    const target = getUser(String(req.body.userId || ''));
    if (!target || target.id === req.user.id) return res.status(400).json({ error: 'Invalid passenger' });
    if (!actionLimiter.allow(`report:${req.user.id}`)) return res.status(429).json({ error: 'Too many reports' });
    const reason = ['harassment', 'spam', 'inappropriate', 'unsafe', 'other'].includes(req.body.reason) ? req.body.reason : 'other';
    const details = String(req.body.details || '').slice(0, 280);
    const messageId = req.body.messageId ? String(req.body.messageId).slice(0, 40) : null;
    const dup = db.prepare("SELECT id FROM reports WHERE reporter_id = ? AND target_id = ? AND status = 'open'").get(req.user.id, target.id);
    if (!dup) {
      db.prepare('INSERT INTO reports (id, reporter_id, target_id, reason, details, message_id, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(uuid(), req.user.id, target.id, reason, details, messageId, 'open', now());
    }
    const reporters = db.prepare("SELECT COUNT(DISTINCT reporter_id) AS n FROM reports WHERE target_id = ? AND status = 'open'").get(target.id).n;
    io.to('crew').emit('crew:alert', { kind: 'report', text: `New report: ${target.display_name} (seat ${target.seat}) — ${reason}` });

    // Auto-moderation: several different passengers reporting the same person => temporary mute until crew review.
    if (reporters >= config.REPORTS_TO_AUTO_MUTE && target.muted_until < now()) {
      const until = now() + config.AUTO_MUTE_MS;
      db.prepare('UPDATE users SET muted_until = ? WHERE id = ?').run(until, target.id);
      audit('system', 'auto-mute', target.id, { reporters });
      io.to(`user:${target.id}`).emit('moderation', { mutedUntil: until, text: 'You have been temporarily muted after multiple reports. The cabin crew will review.' });
      io.to('crew').emit('crew:alert', { kind: 'auto-mute', text: `${target.display_name} (seat ${target.seat}) auto-muted after ${reporters} reports` });
    }
    io.to('crew').emit('crew:dirty');
    res.json({ ok: true });
  });

  // ---------------------------------------------------------------------------
  // Messages
  // ---------------------------------------------------------------------------
  function serializeMessage(row) {
    return {
      id: row.id,
      channel: row.channel,
      kind: row.kind,
      content: row.content,
      filtered: Boolean(row.filtered),
      shielded: Boolean(row.shielded),
      createdAt: row.created_at,
      sender: row.sender_id ? publicUser(getUser(row.sender_id)) : null
    };
  }

  app.get('/api/messages', requireAuth, (req, res) => {
    const channel = String(req.query.channel || LOBBY);
    if (!canRead(req.user, channel)) return res.status(403).json({ error: 'Forbidden' });
    const hidden = new Set(hiddenIds(req.user.id));
    const rows = db.prepare('SELECT * FROM messages WHERE channel = ? ORDER BY created_at DESC LIMIT 100').all(channel).reverse();
    res.json({ messages: rows.filter((r) => !hidden.has(r.sender_id)).map(serializeMessage) });
  });

  function emitToChannel(channel, event, payload, senderId) {
    if (channel.startsWith('dm:')) {
      const [, a, b] = channel.split(':');
      io.to([`user:${a}`, `user:${b}`]).emit(event, payload);
      return;
    }
    const target = channel === LOBBY ? io.to(LOBBY) : io.to(roomChannel(channel.slice(5)));
    const exclude = senderId ? hiddenIds(senderId).map((id) => `user:${id}`) : [];
    (exclude.length ? target.except(exclude) : target).emit(event, payload);
  }

  function systemMessage(channel, content, kind = 'system') {
    const row = { id: uuid(), channel, sender_id: null, kind, content, filtered: 0, shielded: 0, created_at: now() };
    db.prepare(`INSERT INTO messages (id, channel, sender_id, kind, content, filtered, shielded, created_at)
      VALUES (@id, @channel, @sender_id, @kind, @content, @filtered, @shielded, @created_at)`).run(row);
    emitToChannel(channel, 'chat:message', serializeMessage(row));
  }

  // ---------------------------------------------------------------------------
  // Rooms & games
  // ---------------------------------------------------------------------------
  function roomRow(id) {
    return db.prepare('SELECT * FROM rooms WHERE id = ?').get(String(id || '').toUpperCase());
  }

  function roomMembers(roomId) {
    return db.prepare('SELECT u.* FROM room_members m JOIN users u ON u.id = m.user_id WHERE m.room_id = ? ORDER BY m.joined_at').all(roomId);
  }

  function getGame(roomId) {
    const row = db.prepare('SELECT state_json FROM game_states WHERE room_id = ?').get(roomId);
    return row ? JSON.parse(row.state_json) : null;
  }

  function serializeRoom(row) {
    const game = getGame(row.id);
    return {
      id: row.id,
      name: row.name,
      hostId: row.host_id,
      kind: row.kind,
      gameType: row.game_type,
      capacity: row.capacity,
      private: Boolean(row.private),
      members: roomMembers(row.id).map(publicUser),
      bots: row.bots || 0,
      inProgress: Boolean(game && game.status === 'playing')
    };
  }

  function emitRoom(row) {
    const room = serializeRoom(row);
    if (row.private) io.to(roomChannel(row.id)).emit('rooms:update', room);
    else io.emit('rooms:update', room);
  }

  function saveGame(roomId, state) {
    db.prepare(`INSERT INTO game_states (room_id, type, state_json, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(room_id) DO UPDATE SET type = excluded.type, state_json = excluded.state_json, updated_at = excluded.updated_at`)
      .run(roomId, state.type, JSON.stringify(state), now());
    io.to(roomChannel(roomId)).emit('game:state', { roomId, state });
  }

  function humansIn(state) {
    return state.players.filter((p) => !p.bot && !p.out).length;
  }

  /** After every state change: let a bot move, or start the human's turn clock. */
  function scheduleTurn(roomId) {
    clearTimeout(gameTimers.get(roomId));
    gameTimers.delete(roomId);
    const state = getGame(roomId);
    if (!state || state.status !== 'playing') return;
    const cur = games.currentPlayer(state);

    if (cur.bot) {
      gameTimers.set(roomId, setTimeout(() => {
        const live = getGame(roomId);
        if (!live || live.status !== 'playing' || games.currentPlayer(live).id !== cur.id) return;
        try {
          const next = games.applyAction(live, cur.id, games.botAction(live));
          next.turnDeadline = null;
          saveGame(roomId, next);
        } catch (err) {
          console.error('bot move failed', err);
        }
        scheduleTurn(roomId);
      }, config.BOT_DELAY_MS));
      return;
    }

    // Turn clock only matters when other humans are waiting.
    if (humansIn(state) < 2) {
      if (state.turnDeadline) {
        state.turnDeadline = null;
        saveGame(roomId, state);
      }
      return;
    }
    if (!state.turnDeadline || state.turnFor !== `${cur.id}:${state.moves}`) {
      state.turnDeadline = now() + config.TURN_TIMEOUT_MS;
      state.turnFor = `${cur.id}:${state.moves}`;
      saveGame(roomId, state);
    }
    const wait = Math.max(0, state.turnDeadline - now());
    gameTimers.set(roomId, setTimeout(() => {
      let live = getGame(roomId);
      if (!live || live.status !== 'playing' || games.currentPlayer(live).id !== cur.id) return;
      let guard = 0;
      while (live.status === 'playing' && games.currentPlayer(live).id === cur.id && guard < 6) {
        live = games.applyAction(live, cur.id, games.autoAction(live));
        guard += 1;
      }
      live.log.unshift('Turn timed out — auto move');
      live.turnDeadline = null;
      saveGame(roomId, live);
      scheduleTurn(roomId);
    }, wait));
  }

  function startGame(row) {
    const members = roomMembers(row.id);
    const max = games.maxPlayers(row.game_type);
    const players = members.slice(0, max).map((m) => ({ id: m.id }));
    for (let i = 0; i < (row.bots || 0) && players.length < max; i += 1) {
      players.push({ id: `bot:${i + 1}`, bot: true, level: row.bot_level || 'hard' });
    }
    if (players.length < games.minPlayers(row.game_type)) throw new Error('Not enough players — add a bot or wait for someone to join');
    // Rotate who goes first on every rematch.
    const prev = getGame(row.id);
    if (prev && prev.players.length === players.length) {
      const first = players.shift();
      players.push(first);
    }
    const state = games.createGame(row.game_type, players);
    saveGame(row.id, state);
    scheduleTurn(row.id);
    emitRoom(row);
    return state;
  }

  function leaveRoom(roomId, userId, why) {
    const row = roomRow(roomId);
    if (!row) return;
    db.prepare('DELETE FROM room_members WHERE room_id = ? AND user_id = ?').run(row.id, userId);
    io.in(`user:${userId}`).socketsLeave(roomChannel(row.id));
    const game = getGame(row.id);
    if (game && game.status === 'playing' && game.players.some((p) => p.id === userId)) {
      saveGame(row.id, games.forfeit(game, userId));
      scheduleTurn(row.id);
    }
    const remaining = roomMembers(row.id);
    if (!remaining.length) {
      clearTimeout(gameTimers.get(row.id));
      gameTimers.delete(row.id);
      playback.delete(row.id);
      db.prepare('DELETE FROM rooms WHERE id = ?').run(row.id);
      db.prepare('DELETE FROM messages WHERE channel = ?').run(roomChannel(row.id));
      io.emit('rooms:removed', row.id);
      return;
    }
    if (row.host_id === userId) db.prepare('UPDATE rooms SET host_id = ? WHERE id = ?').run(remaining[0].id, row.id);
    const u = getUser(userId);
    if (u && why) systemMessage(roomChannel(row.id), `${u.display_name} ${why}`);
    emitRoom(roomRow(row.id));
  }

  app.get('/api/rooms', requireAuth, (req, res) => {
    const rows = db.prepare(`SELECT * FROM rooms WHERE private = 0 OR id IN (SELECT room_id FROM room_members WHERE user_id = ?)
      ORDER BY created_at DESC LIMIT 100`).all(req.user.id);
    res.json({ rooms: rows.map(serializeRoom), mine: db.prepare('SELECT room_id FROM room_members WHERE user_id = ?').all(req.user.id).map((r) => r.room_id) });
  });

  app.post('/api/rooms', requireAuth, (req, res) => {
    const reason = sendBlockReason(req.user);
    if (reason) return res.status(403).json({ error: reason });
    if (!actionLimiter.allow(`room:${req.user.id}`)) return res.status(429).json({ error: 'Slow down' });
    const kind = ['chat', 'game', 'watch'].includes(req.body.kind) ? req.body.kind : 'chat';
    const gameType = kind === 'game' ? (games.GAME_TYPES.includes(req.body.gameType) ? req.body.gameType : 'tictactoe') : null;
    let name = String(req.body.name || '').replace(/\s+/g, ' ').trim().slice(0, 32);
    if (!name) name = kind === 'game' ? ({ tictactoe: 'Tic-Tac-Toe', connectfour: 'Connect Four', ludo: 'Ludo' })[gameType] : 'Cabin room';
    if (containsProfanity(name)) return res.status(400).json({ error: 'Please choose a different room name' });
    const vsBot = kind === 'game' && Boolean(req.body.vsBot);
    const max = gameType ? games.maxPlayers(gameType) : 12;
    const bots = vsBot ? Math.max(1, Math.min(max - 1, Number(req.body.bots) || 1)) : 0;
    const capacity = vsBot ? 1 : Math.max(2, Math.min(Number(req.body.capacity) || (gameType ? max : config.ROOM_CAPACITY_DEFAULT), gameType ? max : 12));

    // Leave any previous solo bot game so they don't pile up.
    for (const r of db.prepare('SELECT r.id FROM rooms r JOIN room_members m ON m.room_id = r.id WHERE m.user_id = ? AND r.private = 1').all(req.user.id)) {
      leaveRoom(r.id, req.user.id);
    }

    const id = crypto.randomBytes(3).toString('hex').toUpperCase();
    db.prepare(`INSERT INTO rooms (id, name, host_id, kind, game_type, capacity, private, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, name, req.user.id, kind, gameType, capacity, vsBot ? 1 : 0, now());
    db.prepare('UPDATE rooms SET bots = ?, bot_level = ? WHERE id = ?').run(bots, req.body.botLevel === 'easy' ? 'easy' : 'hard', id);
    db.prepare('INSERT INTO room_members (room_id, user_id, joined_at) VALUES (?, ?, ?)').run(id, req.user.id, now());
    io.in(`user:${req.user.id}`).socketsJoin(roomChannel(id));
    const row = roomRow(id);
    if (vsBot) startGame(row);
    emitRoom(row);
    res.json({ room: serializeRoom(row), state: getGame(id) });
  });

  app.post('/api/rooms/:id/join', requireAuth, (req, res) => {
    const row = roomRow(req.params.id);
    if (!row) return res.status(404).json({ error: 'Room not found' });
    if (row.private && !isMember(row.id, req.user.id)) return res.status(403).json({ error: 'This is a private game' });
    if (!isMember(row.id, req.user.id)) {
      const count = roomMembers(row.id).length;
      if (count >= row.capacity) return res.status(400).json({ error: 'Room is full' });
      db.prepare('INSERT INTO room_members (room_id, user_id, joined_at) VALUES (?, ?, ?)').run(row.id, req.user.id, now());
      systemMessage(roomChannel(row.id), `${req.user.display_name} joined`);
    }
    io.in(`user:${req.user.id}`).socketsJoin(roomChannel(row.id));
    emitRoom(row);
    res.json({ room: serializeRoom(row), state: getGame(row.id), playback: watchState(row.id) });
  });

  app.post('/api/rooms/:id/leave', requireAuth, (req, res) => {
    leaveRoom(String(req.params.id).toUpperCase(), req.user.id, 'left');
    res.json({ ok: true });
  });

  app.post('/api/rooms/:id/kick', requireAuth, (req, res) => {
    const row = roomRow(req.params.id);
    if (!row) return res.status(404).json({ error: 'Room not found' });
    if (row.host_id !== req.user.id) return res.status(403).json({ error: 'Only the host can remove people' });
    const targetId = String(req.body.userId || '');
    if (targetId === req.user.id || !isMember(row.id, targetId)) return res.status(400).json({ error: 'Invalid passenger' });
    io.to(`user:${targetId}`).emit('rooms:kicked', { roomId: row.id });
    leaveRoom(row.id, targetId, 'was removed by the host');
    res.json({ ok: true });
  });

  app.post('/api/rooms/:id/bots', requireAuth, (req, res) => {
    const row = roomRow(req.params.id);
    if (!row || row.kind !== 'game') return res.status(404).json({ error: 'Game room not found' });
    if (row.host_id !== req.user.id) return res.status(403).json({ error: 'Only the host can add bots' });
    const max = games.maxPlayers(row.game_type);
    const humans = roomMembers(row.id).length;
    const bots = Math.max(0, Math.min(max - humans, Number(req.body.bots) || 0));
    db.prepare('UPDATE rooms SET bots = ?, capacity = ? WHERE id = ?').run(bots, Math.max(humans, max - bots), row.id);
    emitRoom(roomRow(row.id));
    res.json({ room: serializeRoom(roomRow(row.id)) });
  });

  app.post('/api/rooms/:id/start', requireAuth, (req, res) => {
    const row = roomRow(req.params.id);
    if (!row) return res.status(404).json({ error: 'Room not found' });
    if (row.host_id !== req.user.id) return res.status(403).json({ error: 'Only the host can start' });
    if (row.kind !== 'game') return res.status(400).json({ error: 'Not a game room' });
    const reason = sendBlockReason(req.user);
    if (reason) return res.status(403).json({ error: reason });
    const current = getGame(row.id);
    if (current && current.status === 'playing' && !req.body.force) return res.status(400).json({ error: 'A game is already in progress' });
    try {
      res.json({ state: startGame(row) });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.get('/api/rooms/:id/game', requireAuth, (req, res) => {
    const row = roomRow(req.params.id);
    if (!row || !isMember(row.id, req.user.id)) return res.status(404).json({ error: 'Not found' });
    res.json({ room: serializeRoom(row), state: getGame(row.id), playback: watchState(row.id) });
  });

  // ---------------------------------------------------------------------------
  // Watch together (each device plays its own local copy; only play/pause/seek is synced)
  // ---------------------------------------------------------------------------
  function watchState(roomId) {
    const s = playback.get(roomId);
    if (!s) return null;
    return Object.assign({}, s, { time: s.playing ? s.time + (now() - s.at) / 1000 : s.time, at: now() });
  }

  // ---------------------------------------------------------------------------
  // Files (authenticated download, allow-listed types, forced download)
  // ---------------------------------------------------------------------------
  const extOk = (name) => config.ALLOWED_FILE_EXT.includes(path.extname(String(name || '')).toLowerCase());
  const safeName = (name) => String(name || 'file').replace(/[^\p{L}\p{N} ._()-]/gu, '_').slice(0, 120);

  const upload = multer({
    storage: multer.diskStorage({
      destination: (_req, _file, cb) => cb(null, config.UPLOAD_DIR),
      filename: (_req, _file, cb) => cb(null, crypto.randomBytes(16).toString('hex'))
    }),
    limits: { fileSize: config.MAX_FILE_SIZE, files: 1 },
    fileFilter: (_req, file, cb) => (extOk(file.originalname) ? cb(null, true) : cb(new Error('That file type is not allowed on FlightTalk')))
  });

  function serializeFile(row) {
    return {
      id: row.id,
      channel: row.channel,
      filename: row.filename,
      size: row.size,
      mime: row.mime,
      createdAt: row.created_at,
      sender: publicUser(getUser(row.sender_id))
    };
  }

  function recordFile(user, channel, filename, size, mime, storagePath) {
    const row = { id: uuid(), sender_id: user.id, channel, filename: safeName(filename), size, mime: String(mime || 'application/octet-stream').slice(0, 100), storage_path: storagePath, created_at: now() };
    db.prepare(`INSERT INTO files (id, sender_id, channel, filename, size, mime, storage_path, created_at)
      VALUES (@id, @sender_id, @channel, @filename, @size, @mime, @storage_path, @created_at)`).run(row);
    const payload = serializeFile(row);
    emitToChannel(channel, 'files:new', payload, user.id);
    return payload;
  }

  app.get('/api/files', requireAuth, (req, res) => {
    const channel = String(req.query.channel || LOBBY);
    if (!canRead(req.user, channel)) return res.status(403).json({ error: 'Forbidden' });
    const hidden = new Set(hiddenIds(req.user.id));
    const rows = db.prepare('SELECT * FROM files WHERE channel = ? ORDER BY created_at DESC LIMIT 50').all(channel);
    res.json({ files: rows.filter((r) => !hidden.has(r.sender_id)).map(serializeFile) });
  });

  app.post('/api/files', requireAuth, upload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file' });
    const channel = String(req.body.channel || LOBBY);
    const reason = sendBlockReason(req.user);
    if (reason || !canRead(req.user, channel)) {
      fs.unlink(req.file.path, () => {});
      return res.status(403).json({ error: reason || 'Forbidden' });
    }
    res.json({ file: recordFile(req.user, channel, req.file.originalname, req.file.size, req.file.mimetype, req.file.path) });
  });

  app.get('/api/files/:id/download', requireAuth, (req, res) => {
    const row = db.prepare('SELECT * FROM files WHERE id = ?').get(String(req.params.id));
    if (!row || !canRead(req.user, row.channel)) return res.status(404).json({ error: 'File not found' });
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    res.download(row.storage_path, row.filename, { headers: { 'Content-Type': 'application/octet-stream' } });
  });

  app.post('/api/files/chunk/init', requireAuth, (req, res) => {
    const channel = String(req.body.channel || LOBBY);
    const reason = sendBlockReason(req.user);
    if (reason || !canRead(req.user, channel)) return res.status(403).json({ error: reason || 'Forbidden' });
    const filename = safeName(req.body.filename);
    const size = Number(req.body.size || 0);
    if (!Number.isInteger(size) || size <= 0 || size > config.MAX_CHUNKED_FILE_SIZE) return res.status(400).json({ error: 'File too large' });
    if (!extOk(filename)) return res.status(400).json({ error: 'That file type is not allowed on FlightTalk' });
    const mine = [...chunkSessions.values()].filter((s) => s.userId === req.user.id).length;
    if (mine >= 2) return res.status(429).json({ error: 'Finish your other upload first' });
    const uploadId = uuid();
    const dir = path.join(config.CHUNK_DIR, uploadId);
    fs.mkdirSync(dir, { recursive: true });
    const totalChunks = Math.ceil(size / config.MAX_CHUNK_SIZE);
    chunkSessions.set(uploadId, { userId: req.user.id, channel, filename, size, mime: String(req.body.mime || ''), dir, totalChunks, got: new Map(), createdAt: now() });
    res.json({ uploadId, chunkSize: config.MAX_CHUNK_SIZE, totalChunks });
  });

  const chunkUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: config.MAX_CHUNK_SIZE, files: 1 } });

  app.post('/api/files/chunk', requireAuth, chunkUpload.single('chunk'), (req, res) => {
    const s = chunkSessions.get(String(req.body.uploadId || ''));
    if (!s || s.userId !== req.user.id) return res.status(404).json({ error: 'Unknown upload' });
    const index = Number(req.body.index);
    if (!Number.isInteger(index) || index < 0 || index >= s.totalChunks || !req.file) return res.status(400).json({ error: 'Invalid chunk' });
    const received = [...s.got.values()].reduce((a, b) => a + b, 0) - (s.got.get(index) || 0) + req.file.size;
    if (received > s.size) return res.status(400).json({ error: 'More data than declared' });
    fs.writeFileSync(path.join(s.dir, String(index)), req.file.buffer);
    s.got.set(index, req.file.size); // re-sending a chunk overwrites it: uploads can resume
    res.json({ ok: true, received, have: [...s.got.keys()] });
  });

  app.get('/api/files/chunk/:uploadId', requireAuth, (req, res) => {
    const s = chunkSessions.get(String(req.params.uploadId));
    if (!s || s.userId !== req.user.id) return res.status(404).json({ error: 'Unknown upload' });
    res.json({ have: [...s.got.keys()], totalChunks: s.totalChunks });
  });

  app.post('/api/files/chunk/complete', requireAuth, async (req, res) => {
    const uploadId = String(req.body.uploadId || '');
    const s = chunkSessions.get(uploadId);
    if (!s || s.userId !== req.user.id) return res.status(404).json({ error: 'Unknown upload' });
    const total = [...s.got.values()].reduce((a, b) => a + b, 0);
    if (s.got.size !== s.totalChunks || total !== s.size) return res.status(400).json({ error: 'Upload incomplete', have: [...s.got.keys()] });
    chunkSessions.delete(uploadId);
    const dest = path.join(config.UPLOAD_DIR, crypto.randomBytes(16).toString('hex'));
    try {
      const out = fs.createWriteStream(dest);
      for (let i = 0; i < s.totalChunks; i += 1) {
        const buf = await fs.promises.readFile(path.join(s.dir, String(i)));
        if (!out.write(buf)) await new Promise((r) => out.once('drain', r));
      }
      await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())));
      fs.rm(s.dir, { recursive: true, force: true }, () => {});
      res.json({ file: recordFile(req.user, s.channel, s.filename, s.size, s.mime, dest) });
    } catch (err) {
      fs.rm(s.dir, { recursive: true, force: true }, () => {});
      res.status(500).json({ error: 'Could not save file' });
    }
  });

  // ---------------------------------------------------------------------------
  // Crew console
  // ---------------------------------------------------------------------------
  function requireCrew(req, res, next) {
    const t = String(req.headers['x-crew-token'] || '');
    const exp = crewTokens.get(t);
    if (!exp || exp < now()) return res.status(401).json({ error: 'Crew login required' });
    next();
  }

  app.post('/api/crew/login', (req, res) => {
    const ip = req.socket.remoteAddress;
    const fail = crewFails.get(ip);
    if (fail && fail.until > now()) return res.status(429).json({ error: 'Too many wrong PINs. Try again in a few minutes.' });
    const given = Buffer.from(String(req.body.pin || ''));
    const real = Buffer.from(config.CREW_PIN);
    const ok = given.length === real.length && crypto.timingSafeEqual(given, real);
    if (!ok) {
      // 5 wrong PINs within 5 minutes locks this device out for 5 minutes.
      const f = fail && fail.first > now() - 5 * 60_000 ? fail : { count: 0, first: now(), until: 0 };
      f.count += 1;
      if (f.count >= 5) f.until = now() + 5 * 60_000;
      crewFails.set(ip, f);
      audit('crew', 'login-failed', null, { ip });
      return res.status(401).json({ error: 'Wrong PIN' });
    }
    crewFails.delete(ip);
    const token = crypto.randomBytes(32).toString('hex');
    crewTokens.set(token, now() + 12 * 3600 * 1000);
    audit('crew', 'login', null, null);
    res.json({ token });
  });

  app.get('/api/crew/overview', requireCrew, (_req, res) => {
    const users = db.prepare('SELECT * FROM users ORDER BY seat').all();
    const reportCounts = new Map(db.prepare("SELECT target_id, COUNT(DISTINCT reporter_id) AS n FROM reports WHERE status = 'open' GROUP BY target_id").all().map((r) => [r.target_id, r.n]));
    const reports = db.prepare("SELECT * FROM reports WHERE status = 'open' ORDER BY created_at DESC LIMIT 100").all().map((r) => {
      const t = getUser(r.target_id);
      const by = getUser(r.reporter_id);
      const msg = r.message_id ? db.prepare('SELECT content FROM messages WHERE id = ?').get(r.message_id) : null;
      return {
        id: r.id, reason: r.reason, details: r.details, createdAt: r.created_at, message: msg ? msg.content : null,
        target: t ? { id: t.id, displayName: t.display_name, seat: t.seat, verifiedBy: t.verified_by } : null,
        reporter: by ? { displayName: by.display_name, seat: by.seat } : null
      };
    });
    res.json({
      cabin: cabin(),
      stats: {
        passengers: users.filter((u) => !u.removed).length,
        online: users.filter((u) => (online.get(u.id) || 0) > 0).length,
        messages: db.prepare('SELECT COUNT(*) AS n FROM messages').get().n,
        openReports: reports.length,
        rooms: db.prepare('SELECT COUNT(*) AS n FROM rooms').get().n,
        verifiedByBarcode: users.filter((u) => u.verified_by === 'barcode').length
      },
      passengers: users.map((u) => ({
        id: u.id, displayName: u.display_name, seat: u.seat, flight: u.flight, verifiedBy: u.verified_by,
        online: (online.get(u.id) || 0) > 0, mutedUntil: u.muted_until > now() ? u.muted_until : 0,
        removed: Boolean(u.removed), reports: reportCounts.get(u.id) || 0
      })),
      reports,
      audit: db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT 60').all()
    });
  });

  app.post('/api/crew/settings', requireCrew, (req, res) => {
    if (typeof req.body.flightLock === 'string') {
      const f = req.body.flightLock.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
      db.setting.set('flightLock', f);
      audit('crew', 'flight-lock', null, { flight: f });
    }
    if (typeof req.body.quietMode === 'boolean') {
      db.setting.set('quietMode', req.body.quietMode);
      audit('crew', req.body.quietMode ? 'quiet-mode-on' : 'quiet-mode-off');
      systemMessage(LOBBY, req.body.quietMode
        ? 'Cabin crew have paused FlightTalk chat. Please follow crew instructions and keep your seatbelt fastened.'
        : 'Cabin crew have resumed FlightTalk chat.', 'announcement');
    }
    io.emit('cabin:update', cabin());
    res.json({ cabin: cabin() });
  });

  app.post('/api/crew/announce', requireCrew, (req, res) => {
    const text = String(req.body.text || '').trim().slice(0, 300);
    if (!text) {
      db.setting.set('announcement', null);
    } else {
      const level = req.body.level === 'safety' ? 'safety' : 'info';
      db.setting.set('announcement', { text, level, at: now() });
      systemMessage(LOBBY, text, 'announcement');
      audit('crew', 'announce', null, { text, level });
    }
    io.emit('cabin:update', cabin());
    res.json({ cabin: cabin() });
  });

  app.post('/api/crew/users/:id/mute', requireCrew, (req, res) => {
    const u = getUser(String(req.params.id));
    if (!u) return res.status(404).json({ error: 'Not found' });
    const minutes = Math.max(0, Math.min(24 * 60, Number(req.body.minutes) || 0));
    const until = minutes ? now() + minutes * 60_000 : 0;
    db.prepare('UPDATE users SET muted_until = ? WHERE id = ?').run(until, u.id);
    audit('crew', minutes ? 'mute' : 'unmute', u.id, { minutes });
    io.to(`user:${u.id}`).emit('moderation', { mutedUntil: until, text: minutes ? `The cabin crew muted you for ${minutes} minutes.` : 'The cabin crew unmuted you.' });
    io.to('crew').emit('crew:dirty');
    res.json({ ok: true });
  });

  function removeFromAllRooms(userId) {
    for (const r of db.prepare('SELECT room_id FROM room_members WHERE user_id = ?').all(userId)) leaveRoom(r.room_id, userId, 'left');
  }

  app.post('/api/crew/users/:id/remove', requireCrew, (req, res) => {
    const u = getUser(String(req.params.id));
    if (!u) return res.status(404).json({ error: 'Not found' });
    removeFromAllRooms(u.id);
    db.prepare('UPDATE users SET removed = 1 WHERE id = ?').run(u.id);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(u.id);
    db.prepare("UPDATE reports SET status = 'actioned' WHERE target_id = ? AND status = 'open'").run(u.id);
    audit('crew', 'remove', u.id, { seat: u.seat });
    kickSockets(u.id, 'session:removed', { reason: 'The cabin crew removed you from FlightTalk.' });
    usersDirty();
    res.json({ ok: true });
  });

  // Fixes the "someone scanned my boarding pass first" problem: crew checks the real pass and frees the seat.
  app.post('/api/crew/users/:id/release-seat', requireCrew, (req, res) => {
    const u = getUser(String(req.params.id));
    if (!u) return res.status(404).json({ error: 'Not found' });
    removeFromAllRooms(u.id);
    kickSockets(u.id, 'session:removed', { reason: 'The cabin crew reset this seat. Please scan your boarding pass again.' });
    db.prepare('DELETE FROM users WHERE id = ?').run(u.id);
    audit('crew', 'release-seat', null, { seat: u.seat });
    usersDirty();
    res.json({ ok: true });
  });

  app.post('/api/crew/reports/:id', requireCrew, (req, res) => {
    const status = req.body.status === 'actioned' ? 'actioned' : 'dismissed';
    db.prepare('UPDATE reports SET status = ? WHERE id = ?').run(status, String(req.params.id));
    audit('crew', `report-${status}`, String(req.params.id));
    res.json({ ok: true });
  });

  // Privacy by design: when the flight ends, every passenger record, message and file is erased.
  app.post('/api/crew/end-flight', requireCrew, (_req, res) => {
    for (const t of gameTimers.values()) clearTimeout(t);
    gameTimers.clear();
    playback.clear();
    io.except('crew').emit('session:removed', { reason: 'This flight has ended. All FlightTalk data on this aircraft has been erased.' });
    io.except('crew').disconnectSockets(true);
    const counts = {
      passengers: db.prepare('SELECT COUNT(*) AS n FROM users').get().n,
      messages: db.prepare('SELECT COUNT(*) AS n FROM messages').get().n,
      files: db.prepare('SELECT COUNT(*) AS n FROM files').get().n
    };
    db.transaction(() => {
      for (const t of ['game_states', 'room_members', 'rooms', 'messages', 'files', 'reports', 'blocks', 'chat_requests', 'sessions', 'users', 'audit_log']) {
        db.exec(`DELETE FROM ${t}`);
      }
      db.setting.set('secret', crypto.randomBytes(32).toString('hex'));
      db.setting.set('quietMode', false);
      db.setting.set('announcement', null);
    })();
    for (const f of fs.readdirSync(config.UPLOAD_DIR)) fs.rmSync(path.join(config.UPLOAD_DIR, f), { recursive: true, force: true });
    fs.mkdirSync(config.CHUNK_DIR, { recursive: true });
    chunkSessions.clear();
    online.clear();
    audit('crew', 'end-flight', null, counts);
    io.to('crew').emit('crew:dirty');
    res.json({ ok: true, erased: counts });
  });

  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    const status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
    res.status(status).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'File is too large' : (err.message || 'Request failed') });
  });

  // ---------------------------------------------------------------------------
  // Sockets
  // ---------------------------------------------------------------------------
  io.use((socket, next) => {
    const auth = socket.handshake.auth || {};
    if (auth.crewToken) {
      const exp = crewTokens.get(String(auth.crewToken));
      if (!exp || exp < now()) return next(new Error('Unauthorized'));
      socket.crew = true;
      return next();
    }
    const found = findSession(auth.token);
    if (!found) return next(new Error('Unauthorized'));
    socket.userId = found.user.id;
    next();
  });

  io.on('connection', (socket) => {
    if (socket.crew) {
      socket.join('crew');
      return;
    }
    const userId = socket.userId;
    const me = () => getUser(userId);
    online.set(userId, (online.get(userId) || 0) + 1);
    db.prepare('UPDATE users SET last_seen = ? WHERE id = ?').run(now(), userId);
    socket.join(LOBBY);
    socket.join(`user:${userId}`);
    for (const r of db.prepare('SELECT room_id FROM room_members WHERE user_id = ?').all(userId)) socket.join(roomChannel(r.room_id));
    usersDirty();

    // Flood protection on the socket itself: > 40 events / 5 s disconnects the client.
    let burst = 0;
    const burstTimer = setInterval(() => { burst = 0; }, 5000);
    socket.use((_packet, next) => {
      burst += 1;
      if (burst > 40) {
        socket.emit('notify', { kind: 'error', text: 'Too many actions — reconnecting' });
        socket.disconnect(true);
        return;
      }
      next();
    });

    socket.on('chat:message', (payload, cb) => {
      const reply = typeof cb === 'function' ? cb : () => {};
      try {
        const user = me();
        if (!user || user.removed) throw new Error('Not signed in');
        const channel = String(payload?.channel || LOBBY);
        if (!canRead(user, channel)) throw new Error('You cannot send to this chat');
        const reason = sendBlockReason(user);
        if (reason) throw new Error(reason);
        if (!msgLimiter.allow(`${user.id}:${channel}`) || !userLimiter.allow(user.id)) throw new Error('Slow down — you are sending messages too fast');
        const raw = String(payload?.content || '').replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, '').trim().slice(0, config.MAX_MESSAGE_LENGTH);
        if (!raw) throw new Error('Empty message');
        if (repeat.isSpam(user.id, raw)) throw new Error('Please don’t repeat the same message');

        let { text, filtered } = filterText(raw);
        let shielded = false;
        let piiWarning = null;
        if (channel.startsWith('dm:')) {
          const kinds = detectPII(text);
          if (kinds.length) piiWarning = 'Be careful sharing contact details with people you met on a flight.';
        } else {
          const s = shieldPII(text);
          if (s.kinds.length) {
            text = s.text;
            shielded = true;
            piiWarning = 'Contact details and links are hidden in public chats to keep everyone safe.';
          }
        }
        const row = { id: uuid(), channel, sender_id: user.id, kind: 'user', content: text, filtered: filtered ? 1 : 0, shielded: shielded ? 1 : 0, created_at: now() };
        db.prepare(`INSERT INTO messages (id, channel, sender_id, kind, content, filtered, shielded, created_at)
          VALUES (@id, @channel, @sender_id, @kind, @content, @filtered, @shielded, @created_at)`).run(row);
        const message = serializeMessage(row);
        emitToChannel(channel, 'chat:message', message, user.id);
        if (channel.startsWith('dm:')) notifyRequests(...channel.split(':').slice(1));
        reply({ ok: true, message, warning: piiWarning });
      } catch (err) {
        reply({ ok: false, error: err.message });
      }
    });

    socket.on('chat:typing', (payload) => {
      const user = me();
      const channel = String(payload?.channel || LOBBY);
      if (!user || !canRead(user, channel) || sendBlockReason(user)) return;
      const key = `${channel}:${user.id}`;
      const info = { channel, user: { id: user.id, displayName: user.display_name } };
      if (!typingTimers.has(key)) emitToChannel(channel, 'chat:typing', Object.assign({ typing: true }, info), user.id);
      clearTimeout(typingTimers.get(key));
      typingTimers.set(key, setTimeout(() => {
        typingTimers.delete(key);
        emitToChannel(channel, 'chat:typing', Object.assign({ typing: false }, info), user.id);
      }, 2500));
    });

    socket.on('game:action', (payload, cb) => {
      const reply = typeof cb === 'function' ? cb : () => {};
      try {
        const user = me();
        const roomId = String(payload?.roomId || '').toUpperCase();
        if (!isMember(roomId, user.id)) throw new Error('You are not in this room');
        if (cabin().quietMode) throw new Error('Games are paused by the cabin crew');
        const state = getGame(roomId);
        if (!state) throw new Error('Game has not started');
        const next = games.applyAction(state, user.id, payload.action || {});
        next.turnDeadline = null;
        saveGame(roomId, next);
        scheduleTurn(roomId);
        if (next.status === 'finished') emitRoom(roomRow(roomId));
        reply({ ok: true });
      } catch (err) {
        reply({ ok: false, error: err.message });
      }
    });

    socket.on('game:forfeit', (payload, cb) => {
      const roomId = String(payload?.roomId || '').toUpperCase();
      const state = getGame(roomId);
      if (state && isMember(roomId, userId) && state.status === 'playing') {
        saveGame(roomId, games.forfeit(state, userId));
        scheduleTurn(roomId);
        emitRoom(roomRow(roomId));
      }
      if (typeof cb === 'function') cb({ ok: true });
    });

    socket.on('watch:state', (payload) => {
      const roomId = String(payload?.roomId || '').toUpperCase();
      const row = roomRow(roomId);
      if (!row || row.kind !== 'watch' || row.host_id !== userId) return;
      const s = {
        playing: Boolean(payload.playing),
        time: Math.max(0, Number(payload.time) || 0),
        mediaName: String(payload.mediaName || '').slice(0, 120),
        duration: Math.max(0, Number(payload.duration) || 0),
        at: now()
      };
      playback.set(roomId, s);
      socket.to(roomChannel(roomId)).emit('watch:state', { roomId, state: s });
    });

    socket.on('disconnect', () => {
      clearInterval(burstTimer);
      const n = (online.get(userId) || 1) - 1;
      if (n <= 0) online.delete(userId);
      else online.set(userId, n);
      db.prepare('UPDATE users SET last_seen = ? WHERE id = ?').run(now(), userId);
      usersDirty();
    });
  });

  // ---------------------------------------------------------------------------
  // Housekeeping
  // ---------------------------------------------------------------------------
  const housekeeping = setInterval(() => {
    const cutoff = now() - config.SESSION_TTL_MS;
    db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now());
    db.prepare('DELETE FROM messages WHERE created_at < ?').run(cutoff);
    for (const [token, exp] of crewTokens) if (exp < now()) crewTokens.delete(token);
    for (const [id, s] of chunkSessions) {
      if (s.createdAt < now() - 30 * 60_000) {
        fs.rm(s.dir, { recursive: true, force: true }, () => {});
        chunkSessions.delete(id);
      }
    }
  }, 60_000);
  housekeeping.unref();

  // Resume any games that were in progress before a restart.
  for (const r of db.prepare('SELECT room_id FROM game_states').all()) scheduleTurn(r.room_id);

  function close() {
    clearInterval(housekeeping);
    for (const t of gameTimers.values()) clearTimeout(t);
    io.close();
    return new Promise((resolve) => server.close(() => resolve()));
  }

  return { app, server, io, close, useHttps };
}

module.exports = { createApp };
