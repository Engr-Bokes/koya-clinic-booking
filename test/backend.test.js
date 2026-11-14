'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const { createApp, canonical, validDate, encodeCursor, decodeCursor } = require('../src/app');
const { init } = require('../src/db');

test('canonical JSON identity, date and cursor validation', () => {
  assert.equal(canonical({ b: 2, a: { y: 2, x: 1 } }), canonical({ a: { x: 1, y: 2 }, b: 2 }));
  assert.notEqual(canonical({ name: ' Ada ' }), canonical({ name: 'Ada' }));
  assert.equal(validDate('2028-02-29T12:00:00Z'), true);
  for (const value of ['2027-02-29T12:00:00Z', '2028-02-30T12:00:00Z', 'tomorrow', null]) assert.equal(validDate(value), false);
  const cursor = encodeCursor({ id: 'uuid', created_at: new Date('2030-01-01T00:00:00Z') }, 'ada@example.com');
  assert.deepEqual(decodeCursor(cursor, 'ada@example.com'), [1, 'ada@example.com', '2030-01-01T00:00:00.000Z', 'uuid']);
  assert.throws(() => decodeCursor(cursor, 'other@example.com'));
  assert.throws(() => decodeCursor('bogus', 'ada@example.com'));
});

test('PostgreSQL API integration and concurrency', { skip: !process.env.TEST_DATABASE_URL }, async t => {
  const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 20 });
  await init(pool);
  const server = createApp({ pool, apiKey: 'test-secret' }).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await pool.end(); });
  async function call(method, path, body, extra = {}) {
    const response = await fetch(base + path, { method, headers: { 'X-API-Key': 'test-secret', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...extra }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json(), retry: response.headers.get('retry-after') };
  }
  const slot = (id, offset = 1, provider = 'Dr Ade') => ({ id, provider, start: new Date(Date.now() + offset * 3600000).toISOString(), end: new Date(Date.now() + offset * 3600000 + 1800000).toISOString() });
  const booking = (slot_id, email = 'ada@example.com') => ({ slot_id, name: ' Ada Obi ', email });
  const reset = async slots => assert.equal((await call('POST', '/reset', { slots })).status, 200);

  await t.test('auth covers all methods and JSON errors are standard', async () => {
    for (const [method, path, body] of [['GET','/slots'],['POST','/reset',{ slots: [] }],['POST','/bookings',{}],['DELETE','/bookings/id'],['GET','/bookings/id'],['GET','/bookings?email=a@b.co']]) {
      assert.equal((await call(method, path, body, { 'X-API-Key': '' })).status, 401);
      assert.equal((await call(method, path, body, { 'X-API-Key': 'wrong' })).status, 401);
    }
    const malformed = await fetch(base + '/bookings', { method: 'POST', headers: { 'X-API-Key': 'test-secret', 'Content-Type': 'application/json' }, body: '{' });
    assert.equal(malformed.status, 400);
    assert.deepEqual(Object.keys(await malformed.json()), ['error']);
    assert.equal((await call('GET', '/missing')).status, 404);
  });
  await t.test('reset validation, availability, exact provider and ordering', async () => {
    const slots = [slot('later', 3), slot('past', -2), slot('first', 1, 'Dr Other')];
    await reset(slots);
    const listed = await call('GET','/slots');
    assert.deepEqual(listed.body.slots.map(s => s.id), ['past','first','later']);
    assert(listed.body.slots.every(s => s.available));
    assert.deepEqual((await call('GET','/slots?provider=Dr%20Ade')).body.slots.map(s => s.id), ['past','later']);
    assert.deepEqual((await call('GET','/slots?provider=dr%20ade')).body.slots, []);
    assert.equal((await call('POST','/reset',{ slots: [slots[0], slots[0]] })).status, 400);
    assert.equal((await call('POST','/reset',{ slots: [{ ...slots[0], end: slots[0].start }] })).status, 400);
    assert.equal((await call('GET','/slots')).body.slots.length, 3);
  });
  await t.test('validation, unknown and past slot, normalization', async () => {
    await reset([slot('future'),slot('past',-1)]);
    for (const body of [{}, { slot_id:'future', name:' ',email:'bad@example.com' }, { slot_id:'future',name:'Ada',email:'not-an-email' }, { slot_id: 1,name:'Ada',email:'bad2@example.com' }]) assert.equal((await call('POST','/bookings',body)).status, 400);
    assert.equal((await call('POST','/bookings',booking('missing','missing@example.com'))).status,404);
    assert.equal((await call('POST','/bookings',booking('past','past@example.com'))).status,400);
    const created = await call('POST','/bookings',booking('future',' ADA@Example.Com '));
    assert.equal(created.status,201);
    assert.equal(created.body.name,'Ada Obi');
    assert.equal(created.body.email,'ada@example.com');
    assert.equal(created.body.status,'confirmed');
    assert.deepEqual((await call('GET',`/bookings/${created.body.id}`)).body,created.body);
    assert.equal((await call('GET','/slots')).body.slots.find(s => s.id === 'future').available,false);
  });
  await t.test('parallel booking invariant, cancellation and rebooking', async () => {
    await reset([slot('race')]);
    const responses = await Promise.all(Array.from({length:16},(_,i) => call('POST','/bookings',booking('race',`r${i}@example.com`))));
    assert.equal(responses.filter(r => r.status === 201).length,1);
    assert.equal(responses.filter(r => r.status === 409).length,15);
    const winner = responses.find(r => r.status === 201).body;
    const cancels = await Promise.all([call('DELETE',`/bookings/${winner.id}`),call('DELETE',`/bookings/${winner.id}`)]);
    assert.deepEqual(cancels.map(r => r.status).sort(),[200,409]);
    assert.equal((await call('GET','/slots')).body.slots[0].available,true);
    assert.equal((await call('POST','/bookings',booking('race','new@example.com'))).status,201);
    assert.equal((await call('DELETE','/bookings/no-such-booking')).status,404);
  });
  await t.test('parallel idempotency replay and mismatch, durable across app instances', async () => {
    await reset([slot('idem')]);
    const body = booking('idem');
    const requests = await Promise.all(Array.from({length:12},() => call('POST','/bookings',body,{'Idempotency-Key':'same'})));
    assert(requests.every(r => r.status === 201));
    for (const response of requests) assert.deepEqual(response.body, requests[0].body);
    assert.equal((await pool.query('SELECT count(*)::integer AS n FROM clinic_bookings')).rows[0].n,1);
    assert.equal((await pool.query('SELECT count(*)::integer AS n FROM clinic_attempts')).rows[0].n,1);
    assert.equal((await call('POST','/bookings',{...body,name:'Different'},{'Idempotency-Key':'same'})).status,422);
    const secondServer = createApp({pool,apiKey:'test-secret'}).listen(0,'127.0.0.1');
    await new Promise(resolve => secondServer.once('listening',resolve));
    try {
      const replay = await fetch(`http://127.0.0.1:${secondServer.address().port}/bookings`, { method:'POST', headers:{'X-API-Key':'test-secret','Content-Type':'application/json','Idempotency-Key':'same'},body:JSON.stringify(body) });
      assert.equal(replay.status,201); assert.deepEqual(await replay.json(),requests[0].body);
    } finally { await new Promise(resolve => secondServer.close(resolve)); }
    await call('DELETE',`/bookings/${requests[0].body.id}`);
    assert.deepEqual((await call('POST','/bookings',body,{'Idempotency-Key':'same'})).body,requests[0].body);
  });
  await t.test('failed outcomes cached, key-body comparison precedes normalization', async () => {
    await reset([slot('cached')]);
    const body = booking('unknown');
    const first = await call('POST','/bookings',body,{'Idempotency-Key':'failed'});
    assert.equal(first.status,404);
    assert.deepEqual(await call('POST','/bookings',body,{'Idempotency-Key':'failed'}),first);
    assert.equal((await call('POST','/bookings',{...body,email:'ADA@example.com'},{'Idempotency-Key':'failed'})).status,422);
  });
  await t.test('durable rolling rate limit includes validation and failed attempts', async () => {
    await reset([slot('limit')]);
    for(let i=0;i<5;i++) assert.equal((await call('POST','/bookings',booking('missing',i%2 ? ' RATE@example.com ' : 'rate@example.com'))).status,404);
    const blocked = await call('POST','/bookings',booking('limit','rate@example.com'),{'Idempotency-Key':'throttled'});
    assert.equal(blocked.status,429);
    assert.match(blocked.retry,/^[1-9]\d*$/); assert(Number(blocked.retry)<=60);
    assert.deepEqual(await call('POST','/bookings',booking('limit','rate@example.com'),{'Idempotency-Key':'throttled'}),blocked);
    assert.equal((await call('POST','/bookings',booking('limit','other@example.com'))).status,201);
    await pool.query("UPDATE clinic_attempts SET attempted_at=clock_timestamp()-interval '61 seconds' WHERE email=$1",['rate@example.com']);
    assert.equal((await call('POST','/bookings',booking('missing','rate@example.com'))).status,404);
    await reset([slot('parallel')]);
    const responses = await Promise.all(Array.from({length:12},() => call('POST','/bookings',booking('missing','parallel@example.com'))));
    assert.equal(responses.filter(r => r.status === 404).length,5);
    assert.equal(responses.filter(r => r.status === 429).length,7);
    await reset([]);
    for(let i=0;i<5;i++) assert.equal((await call('POST','/bookings',{name:'',email:'validation@example.com'})).status,400);
    assert.equal((await call('POST','/bookings',booking('missing','validation@example.com'))).status,429);
  });
  await t.test('stable cursor pagination on ties and strict query validation', async () => {
    await reset(Array.from({length:12},(_,i) => slot(`page-${i}`)));
    // Seed tied timestamps directly to prove (created_at,id), bypassing rate limiter.
    for(let i=0;i<12;i++) await pool.query("INSERT INTO clinic_bookings(id,slot_id,name,email,status,created_at) VALUES($1,$2,'Ada','ada@example.com','confirmed','2030-01-01T00:00:00.123Z')",[`b${String(i).padStart(2,'0')}`,`page-${i}`]);
    const all = [], cursors = []; let cursor;
    do {
      const page = await call('GET','/bookings?email=ADA%40example.com&limit=5'+(cursor ? '&cursor='+cursor : ''));
      assert.equal(page.status,200); all.push(...page.body.bookings); cursor=page.body.next_cursor;
      if(cursor) cursors.push(cursor);
    } while(cursor);
    assert.equal(all.length,12); assert.equal(new Set(all.map(b=>b.id)).size,12);
    assert.deepEqual(all.map(b=>b.id),Array.from({length:12},(_,i)=>`b${String(i).padStart(2,'0')}`));
    assert.equal((await call('GET','/bookings?email=ada@example.com')).body.bookings.length,10);
    for(const limit of ['0','51','-1','1.5','abc','','Infinity','1e1','01']) assert.equal((await call('GET',`/bookings?email=ada@example.com&limit=${limit}`)).status,400);
    assert.equal((await call('GET','/bookings?email=ada@example.com&limit=1&limit=2')).status,400);
    assert.equal((await call('GET','/bookings?email=ada@example.com&cursor=garbage')).status,400);
    assert.equal((await call('GET',`/bookings?email=other@example.com&cursor=${cursors[0]}`)).status,400);
  });
  await t.test('reset clears all durable bookkeeping and serializes concurrent mutations', async () => {
    await reset([slot('reset')]);
    await call('POST','/bookings',booking('reset'),{'Idempotency-Key':'reset-key'});
    const actions = await Promise.all([call('POST','/reset',{slots:[slot('reset')]}), ...Array.from({length:8},(_,i)=>call('POST','/bookings',booking('reset',`reset${i}@example.com`),{'Idempotency-Key':`reset${i}`}))]);
    assert.equal(actions[0].status,200);
    assert(actions.slice(1).every(r => [201,409].includes(r.status)));
    const duplicates = await pool.query("SELECT slot_id FROM clinic_bookings WHERE status='confirmed' GROUP BY slot_id HAVING count(*)>1");
    assert.equal(duplicates.rowCount,0);
    await reset([slot('reset')]);
    for(const table of ['clinic_bookings','clinic_idempotency','clinic_attempts']) assert.equal((await pool.query(`SELECT count(*)::integer AS n FROM ${table}`)).rows[0].n,0);
    assert.equal((await call('POST','/bookings',booking('reset'),{'Idempotency-Key':'reset-key'})).status,201);
  });
});

test('authentication and malformed input reject before database access', async t => {
  let connections = 0;
  const pool = { connect: async () => { connections++; throw Error('Unexpected DB access'); } };
  const server = createApp({ pool, apiKey: 'unit-key' }).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const headers of [{}, { 'X-API-Key': 'incorrect' }]) {
    const response = await fetch(base + '/slots', { headers });
    assert.equal(response.status, 401); assert.deepEqual(Object.keys(await response.json()), ['error']);
  }
  const malformed = await fetch(base + '/bookings', { method:'POST', headers:{'X-API-Key':'unit-key','Content-Type':'application/json'}, body:'{' });
  assert.equal(malformed.status,400);
  const badReset = await fetch(base + '/reset', { method:'POST', headers:{'X-API-Key':'unit-key','Content-Type':'application/json'}, body:JSON.stringify({slots:[{id:'incomplete'}]}) });
  assert.equal(badReset.status,400);
  const badLimit = await fetch(base + '/bookings?email=a@example.com&limit=0', { headers:{'X-API-Key':'unit-key'} });
  assert.equal(badLimit.status,400);
  assert.equal(connections,0);
});
