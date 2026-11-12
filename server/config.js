'use strict';

const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = process.env.FT_DATA_DIR || path.join(ROOT, 'data');

module.exports = {
  PORT: Number(process.env.PORT) || 3001,
  HOST: process.env.HOST || '0.0.0.0',
  ROOT,
  DATA_DIR,
  UPLOAD_DIR: path.join(DATA_DIR, 'uploads'),
  CHUNK_DIR: path.join(DATA_DIR, 'uploads', 'chunks'),
  DB_PATH: process.env.FT_DB_PATH || path.join(DATA_DIR, 'flighttalk.db'),

  // Crew console PIN. If not set, a random one is generated and printed at startup.
  CREW_PIN: process.env.CREW_PIN || String(crypto.randomInt(100000, 1000000)),

  // Optional: lock the cabin to one flight at startup (crew can also set it in the console).
  FLIGHT: (process.env.FT_FLIGHT || '').toUpperCase().replace(/[^A-Z0-9]/g, ''),

  // Files
  MAX_FILE_SIZE: 25 * 1024 * 1024,
  MAX_CHUNKED_FILE_SIZE: 200 * 1024 * 1024,
  MAX_CHUNK_SIZE: 1024 * 1024,
  ALLOWED_FILE_EXT: [
    '.jpg', '.jpeg', '.png', '.gif', '.webp', '.heic',
    '.pdf', '.txt', '.md', '.csv', '.docx', '.xlsx', '.pptx',
    '.mp3', '.m4a', '.aac', '.wav', '.mp4', '.mov', '.webm', '.mkv', '.zip'
  ],

  // Chat safety
  RATE_WINDOW_MS: 10_000,
  RATE_MAX_MESSAGES: 8,
  MAX_MESSAGE_LENGTH: 500,
  REPORTS_TO_AUTO_MUTE: 3, // distinct reporters
  AUTO_MUTE_MS: 30 * 60 * 1000,
  MAX_PENDING_REQUESTS: 5,
  REQUEST_COOLDOWN_MS: 10 * 60 * 1000,

  // Rooms / games
  ROOM_CAPACITY_DEFAULT: 8,
  TURN_TIMEOUT_MS: Number(process.env.FT_TURN_TIMEOUT_MS) || 45_000,
  BOT_DELAY_MS: Number(process.env.FT_BOT_DELAY_MS ?? 650),

  // Sessions
  SESSION_TTL_MS: 20 * 60 * 60 * 1000, // longest commercial flight + buffer
  JOIN_ATTEMPTS_PER_MIN: Number(process.env.FT_JOIN_LIMIT) || 10
};
