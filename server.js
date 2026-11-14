const express = require('express');
const path = require('node:path');
const { Pool } = require('pg');
const { createApp } = require('./src/app');
const { initDb } = require('./src/db');

async function start() {
  const apiKey = process.env.API_KEY;
  if (!process.env.DATABASE_URL || !apiKey) {
    throw new Error('DATABASE_URL and API_KEY must be configured.');
  }
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 10 });
  await initDb(pool);
  const app = express();
  app.disable('x-powered-by');
  app.use(express.static(path.join(__dirname, 'public')));
  app.use(createApp({ pool, apiKey }));
  const server = app.listen(Number(process.env.PORT) || 3000, '127.0.0.1', () => {
    console.log(`CareSlot is running at http://localhost:${server.address().port}`);
  });
  async function close() {
    server.close(async () => { await pool.end(); process.exit(0); });
  }
  process.on('SIGINT', close);
  process.on('SIGTERM', close);
}
start().catch((error) => {
  console.error('Unable to start CareSlot:', error.message);
  process.exitCode = 1;
});
