const { Pool } = require('pg');
const { createHttpApp } = require('../src/http');
const { initDb } = require('../src/db');
let ready;

module.exports = async (req, res) => {
  if (!ready) {
    ready = (async () => {
      if (!process.env.DATABASE_URL || !process.env.API_KEY) throw new Error('Missing server configuration');
      const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 5 });
      await initDb(pool);
      return createHttpApp({ pool, apiKey: process.env.API_KEY });
    })().catch(error => { ready = undefined; throw error; });
  }
  try {
    const app = await ready;
    return app(req, res);
  } catch (error) {
    console.error('API unavailable:', error.message);
    res.statusCode = 503;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Service temporarily unavailable' }));
  }
};
