'use strict';
const fs = require('node:fs');
const path = require('node:path');
const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
async function init(pool) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(7163, 1)');
    await client.query(schema);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}
module.exports = { schema, init };
module.exports.initDb = init;
