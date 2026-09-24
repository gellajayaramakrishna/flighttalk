'use strict';

const path = require('path');

module.exports = {
  PORT: Number(process.env.PORT) || 3001,
  HOST: process.env.HOST || '0.0.0.0',
  DATA_DIR: path.join(__dirname, '..', 'data'),
  UPLOAD_DIR: path.join(__dirname, '..', 'uploads'),
  CHUNK_DIR: path.join(__dirname, '..', 'uploads', 'chunks'),
  DB_PATH: path.join(__dirname, '..', 'data', 'flighttalk.db'),
  MAX_FILE_SIZE: 50 * 1024 * 1024,
  MAX_CHUNK_SIZE: 1024 * 1024,
  RATE_WINDOW_MS: 10_000,
  RATE_MAX_MESSAGES: 8,
  ROOM_CAPACITY_DEFAULT: 8,
  SESSION_TTL_MS: 24 * 60 * 60 * 1000
};
