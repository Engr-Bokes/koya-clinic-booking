'use strict';
const express = require('express');
const { randomUUID, timingSafeEqual } = require('node:crypto');
const result = (status, body, headers = {}) => ({ status, body, headers });
const error = (status, message, headers) => result(status, { error: message }, headers);
const string = value => typeof value === 'string' && value.trim().length > 0;
const emailOf = value => typeof value === 'string' ? value.trim().toLowerCase() : '';
const validEmail = value => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (object(value)) return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  return JSON.stringify(value);
}
function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return false;
  const day = Number(value.slice(8, 10)), month = Number(value.slice(5, 7)), year = Number(value.slice(0, 4));
  return month >= 1 && month <= 12 && day >= 1 && day <= new Date(Date.UTC(year, month, 0)).getUTCDate() && Number(value.slice(11, 13)) < 24 && Number(value.slice(14, 16)) < 60 && Number(value.slice(17, 19)) < 60 && Number.isFinite(Date.parse(value));
}
function encodeCursor(row, email) {
  return Buffer.from(JSON.stringify([1, email, row.created_at.toISOString(), row.id])).toString('base64url');
}
function decodeCursor(value, email) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) throw Error('Invalid cursor');
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.toString('base64url') !== value) throw Error('Invalid cursor');
  const data = JSON.parse(bytes.toString());
  if (!Array.isArray(data) || data.length !== 4 || data[0] !== 1 || data[1] !== email || !validDate(data[2]) || !string(data[3])) throw Error('Invalid cursor');
  return data;
}
function createApp({ pool, apiKey }) {
  if (!pool || !string(apiKey)) throw Error('pool and nonempty apiKey are required');
  const app = express();
  app.disable('x-powered-by');
  app.set('query parser', 'simple');
  app.use((req, res, next) => {
    const supplied = Buffer.from(req.get('X-API-Key') || '');
    const expected = Buffer.from(apiKey);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return res.status(401).json({ error: 'Unauthorized' });
    next();
  });
  app.use(express.json({ limit: '1mb' }));
  async function tx(fn, exclusive = false) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT pg_advisory_xact_lock${exclusive ? '' : '_shared'}(7163, 1)`);
      const response = await fn(client);
      await client.query('COMMIT');
      return response;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally { client.release(); }
  }
  const route = fn => async (req, res, next) => {
    try {
      const response = await fn(req);
      res.set(response.headers).status(response.status).json(response.body);
    } catch (err) { next(err); }
  };
  const lock = (client, kind, value) => client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`clinic:${kind}:${value}`]);
  app.post('/reset', route(async req => {
    const slots = req.body?.slots;
    if (!Array.isArray(slots)) return error(400, 'slots must be an array');
    const ids = new Set();
    for (const slot of slots) {
      if (!object(slot) || !string(slot.id) || !string(slot.provider) || !validDate(slot.start) || !validDate(slot.end) || Date.parse(slot.start) >= Date.parse(slot.end) || ids.has(slot.id)) return error(400, 'Invalid or duplicate slot');
      ids.add(slot.id);
    }
    return tx(async client => {
      await client.query('DELETE FROM clinic_idempotency; DELETE FROM clinic_attempts; DELETE FROM clinic_bookings; DELETE FROM clinic_slots');
      if (slots.length) await client.query(`INSERT INTO clinic_slots(id, provider, start, "end") SELECT id, provider, start::timestamptz, "end"::timestamptz FROM jsonb_to_recordset($1::jsonb) AS s(id text, provider text, start text, "end" text)`, [JSON.stringify(slots)]);
      return result(200, { ok: true });
    }, true);
  }));
  app.get('/slots', route(async req => {
    if (req.query.provider !== undefined && typeof req.query.provider !== 'string') return error(400, 'Invalid provider');
    return tx(async client => result(200, { slots: (await client.query(`SELECT s.*, NOT EXISTS (SELECT 1 FROM clinic_bookings b WHERE b.slot_id=s.id AND b.status='confirmed') AS available FROM clinic_slots s WHERE ($1::text IS NULL OR s.provider=$1) ORDER BY s.start, s.id`, [req.query.provider ?? null])).rows }));
  }));
  app.post('/bookings', route(async req => {
    const key = req.get('Idempotency-Key');
    if (key !== undefined && !string(key)) return error(400, 'Invalid Idempotency-Key');
    const body = req.body ?? null, signature = canonical(body);
    return tx(async client => {
      if (key !== undefined) {
        await lock(client, 'idempotency', key);
        const cached = (await client.query('SELECT * FROM clinic_idempotency WHERE key=$1', [key])).rows[0];
        if (cached) return cached.request_body === signature ? result(cached.status, cached.response, cached.headers) : error(422, 'Idempotency-Key reused with a different body');
      }
      async function finish(response) {
        if (key !== undefined) await client.query('INSERT INTO clinic_idempotency(key, request_body, status, response, headers) VALUES($1,$2,$3,$4,$5)', [key, signature, response.status, JSON.stringify(response.body), JSON.stringify(response.headers)]);
        return response;
      }
      const email = emailOf(body?.email);
      // Replays/mismatches precede throttling; every new attempt with an email,
      // including validation errors and 429s, is recorded durably.
      if (email) {
        await lock(client, 'email', email);
        await client.query("DELETE FROM clinic_attempts WHERE email=$1 AND attempted_at <= clock_timestamp() - interval '60 seconds'", [email]);
        const recent = (await client.query("SELECT attempted_at FROM clinic_attempts WHERE email=$1 AND attempted_at > clock_timestamp() - interval '60 seconds' ORDER BY attempted_at DESC LIMIT 5", [email])).rows;
        await client.query('INSERT INTO clinic_attempts(email) VALUES($1)', [email]);
        if (recent.length >= 5) {
          const retry = (await client.query("SELECT GREATEST(1, CEIL(EXTRACT(EPOCH FROM (attempted_at + interval '60 seconds' - clock_timestamp()))))::integer AS seconds FROM clinic_attempts WHERE email=$1 ORDER BY attempted_at DESC OFFSET 4 LIMIT 1", [email])).rows[0].seconds;
          return finish(error(429, 'Too many booking attempts', { 'Retry-After': String(retry) }));
        }
      }
      if (!object(body) || !string(body.slot_id) || !string(body.name) || !validEmail(email)) return finish(error(400, 'slot_id, name and a valid email are required'));
      const slot = (await client.query('SELECT * FROM clinic_slots WHERE id=$1 FOR UPDATE', [body.slot_id])).rows[0];
      if (!slot) return finish(error(404, 'Slot not found'));
      // Evaluate time after obtaining the row lock, including any contention wait.
      const started = (await client.query('SELECT $1::timestamptz <= clock_timestamp() AS started', [slot.start])).rows[0].started;
      if (started) return finish(error(400, 'Slot has already started'));
      // Partial unique index is the final invariant, not just a preflight check.
      const booking = (await client.query(`INSERT INTO clinic_bookings(id,slot_id,name,email,status) VALUES($1,$2,$3,$4,'confirmed') ON CONFLICT (slot_id) WHERE status='confirmed' DO NOTHING RETURNING *`, [randomUUID(), body.slot_id, body.name.trim(), email])).rows[0];
      return finish(booking ? result(201, booking) : error(409, 'Slot already booked'));
    });
  }));
  app.get('/bookings', route(async req => {
    const email = emailOf(req.query.email), rawLimit = req.query.limit;
    if (!validEmail(email)) return error(400, 'A valid email is required');
    if (rawLimit !== undefined && (typeof rawLimit !== 'string' || !/^(?:[1-9]|[1-4]\d|50)$/.test(rawLimit))) return error(400, 'limit must be an integer from 1 to 50');
    const limit = rawLimit === undefined ? 10 : Number(rawLimit);
    let cursor;
    try { cursor = req.query.cursor === undefined ? null : decodeCursor(req.query.cursor, email); }
    catch { return error(400, 'Invalid cursor'); }
    return tx(async client => {
      const rows = (await client.query(`SELECT * FROM clinic_bookings WHERE email=$1 AND ($2::timestamptz IS NULL OR (created_at,id) > ($2::timestamptz,$3::text)) ORDER BY created_at,id LIMIT $4`, [email, cursor?.[2] ?? null, cursor?.[3] ?? null, limit + 1])).rows;
      const bookings = rows.slice(0, limit);
      return result(200, { bookings, next_cursor: rows.length > limit ? encodeCursor(bookings[bookings.length - 1], email) : null });
    });
  }));
  app.get('/bookings/:id', route(req => tx(async client => {
    const booking = (await client.query('SELECT * FROM clinic_bookings WHERE id=$1', [req.params.id])).rows[0];
    return booking ? result(200, booking) : error(404, 'Booking not found');
  })));
  app.delete('/bookings/:id', route(req => tx(async client => {
    const booking = (await client.query('SELECT * FROM clinic_bookings WHERE id=$1', [req.params.id])).rows[0];
    if (!booking) return error(404, 'Booking not found');
    // Same slot-first lock ordering as booking, including double cancellations.
    await client.query('SELECT id FROM clinic_slots WHERE id=$1 FOR UPDATE', [booking.slot_id]);
    const updated = (await client.query("UPDATE clinic_bookings SET status='cancelled' WHERE id=$1 AND status='confirmed' RETURNING *", [req.params.id])).rows[0];
    return updated ? result(200, updated) : error(409, 'Booking already cancelled');
  })));
  app.use((req, res) => res.status(404).json({ error: 'Not found' }));
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    const status = err.type === 'entity.too.large' ? 413 : err.status === 400 ? 400 : 500;
    res.status(status).json({ error: status === 500 ? 'Internal server error' : status === 413 ? 'Request body too large' : 'Invalid JSON request' });
  });
  return app;
}
module.exports = { createApp, canonical, validDate, encodeCursor, decodeCursor };
