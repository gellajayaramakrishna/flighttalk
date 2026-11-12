#!/usr/bin/env node
/*
 * Cabin load test: N simulated passengers on one FlightTalk server.
 *
 *   node bench/load-test.js --users 250 --rate 20 --seconds 20
 *
 * - starts a fresh server in a child process (temp database)
 * - every passenger scans in (HTTP join) and opens a Socket.IO connection
 * - passengers send cabin-chat messages at --rate messages/second in total
 * - every delivery to every other passenger is timed (send -> receive)
 * Reports join time, delivery latency percentiles, fan-out throughput and server memory.
 */
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { io } = require('socket.io-client');

const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) => (a.startsWith('--') ? [a.slice(2), all[i + 1]] : null)).filter(Boolean));
const USERS = Number(args.users || 250);
const RATE = Number(args.rate || 20);
const SECONDS = Number(args.seconds || 20);
const PORT = Number(args.port || 3900 + Math.floor(Math.random() * 90));
const BASE = `http://127.0.0.1:${PORT}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];

function serverRssMb(pid) {
  try {
    const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
    return Math.round(Number(status.match(/VmRSS:\s+(\d+)/)[1]) / 1024);
  } catch {
    try {
      return Math.round(Number(require('child_process').execSync(`ps -o rss= -p ${pid}`).toString().trim()) / 1024);
    } catch { return null; }
  }
}

async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-load-'));
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
    env: Object.assign({}, process.env, { PORT: String(PORT), HOST: '127.0.0.1', FT_DATA_DIR: dataDir, FT_JOIN_LIMIT: '100000', CREW_PIN: '111111' }),
    stdio: 'ignore'
  });
  for (let i = 0; i < 50; i += 1) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) break; } catch { /* starting */ }
    await sleep(100);
  }

  console.log(`FlightTalk load test: ${USERS} passengers, ${RATE} msg/s for ${SECONDS}s (${os.cpus()[0].model}, ${os.cpus().length} cores, Node ${process.version})`);

  // 1. Boarding: everyone scans in.
  const t0 = Date.now();
  const joins = [];
  const rows = 'ABCDEFHJK';
  for (let i = 0; i < USERS; i += 1) {
    const seat = `${Math.floor(i / rows.length) + 1}${rows[i % rows.length]}`;
    joins.push(fetch(`${BASE}/api/auth/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ flight: 'AI865', seat, name: { surname: `LOAD${i}`, given: 'TEST' }, source: 'barcode', displayName: `P${i}`, openToChat: true })
    }).then((r) => r.json()));
  }
  const users = await Promise.all(joins);
  const joinMs = Date.now() - t0;

  // 2. Everyone connects.
  const t1 = Date.now();
  const latencies = [];
  const sent = new Map();
  let delivered = 0;
  const sockets = await Promise.all(users.map((u) => new Promise((resolve, reject) => {
    const s = io(BASE, { auth: { token: u.token }, transports: ['websocket'], forceNew: true });
    s.on('connect', () => resolve(s));
    s.on('connect_error', reject);
    s.on('chat:message', (m) => {
      const start = sent.get(m.content);
      if (start !== undefined) {
        latencies.push(Number(process.hrtime.bigint() - start) / 1e6);
        delivered += 1;
      }
    });
  })));
  const connectMs = Date.now() - t1;
  const rssIdle = serverRssMb(server.pid);

  // 3. Chat traffic.
  const interval = 1000 / RATE;
  const total = RATE * SECONDS;
  let errors = 0;
  const t2 = Date.now();
  for (let i = 0; i < total; i += 1) {
    const s = sockets[i % sockets.length];
    const content = `load message ${i} from the cabin`;
    sent.set(content, process.hrtime.bigint());
    s.emit('chat:message', { channel: 'lobby', content }, (ack) => { if (!ack || !ack.ok) errors += 1; });
    const target = t2 + (i + 1) * interval;
    const wait = target - Date.now();
    if (wait > 0) await sleep(wait);
  }
  await sleep(1500);
  const trafficMs = Date.now() - t2;
  const rssPeak = serverRssMb(server.pid);

  latencies.sort((a, b) => a - b);
  const expected = total * USERS; // sender also receives its own message
  const result = {
    users: USERS,
    joinAllMs: joinMs,
    connectAllMs: connectMs,
    messagesSent: total,
    sendErrors: errors,
    deliveries: delivered,
    deliveryRate: `${((100 * delivered) / expected).toFixed(2)}%`,
    deliveriesPerSec: Math.round(delivered / (trafficMs / 1000)),
    latencyMs: {
      p50: +pct(latencies, 50).toFixed(1),
      p95: +pct(latencies, 95).toFixed(1),
      p99: +pct(latencies, 99).toFixed(1),
      max: +latencies[latencies.length - 1].toFixed(1)
    },
    serverRssMb: { idleConnected: rssIdle, afterTraffic: rssPeak }
  };
  console.log(JSON.stringify(result, null, 2));

  sockets.forEach((s) => s.disconnect());
  server.kill();
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.mkdirSync(path.join(__dirname, 'results'), { recursive: true });
  fs.writeFileSync(path.join(__dirname, 'results', `load-${USERS}.json`), JSON.stringify(Object.assign({ machine: `${os.cpus()[0].model} x${os.cpus().length}`, node: process.version, rate: RATE, seconds: SECONDS }, result), null, 2));
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
