'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const { createHttpApp, apiDescription } = require('../src/http');
const { initDb } = require('../src/db');

async function listen(app) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

test('public API discovery contains placeholders, not a private key; clinical routes require auth', async t => {
  const secret = 'test-only-private-key';
  const pool = { connect() { throw Error('Discovery/auth must not access a database'); } };
  const { server, base } = await listen(createHttpApp({ pool, apiKey: secret }));
  t.after(() => new Promise(resolve => server.close(resolve)));
  for (const path of ['/api', '/api/']) {
    const r = await fetch(base + path); assert.equal(r.status,200);
    const body=await r.json(); assert.deepEqual(body,apiDescription); assert.equal(body.documentation,'/docs');
    assert.equal(body.authentication.example,'YOUR_API_KEY'); assert.ok(!JSON.stringify(body).includes(secret));
  }
  for (const path of ['/api/slots','/api/bookings','/slots','/bookings']) {
    const r=await fetch(base+path); assert.equal(r.status,401); assert.deepEqual(await r.json(),{error:'Unauthorized'});
  }
});

// A separate schema keeps this file independent of backend.test.js resets.
// Transaction poolers may reject startup search_path; use a direct test connection.
const testConnection = process.env.TEST_DIRECT_DATABASE_URL || process.env.TEST_DATABASE_URL;
test('prefixed API performs real PostgreSQL bookings and shares data with legacy endpoints', { skip: !testConnection }, async t => {
  const admin=new Pool({connectionString:testConnection});
  const schema=`http_test_${process.pid}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool=new Pool({connectionString:testConnection,max:12,options:`-c search_path=${schema}`});
  let server;
  t.after(async()=>{if(server)await new Promise(resolve=>server.close(resolve));await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();});
  await initDb(pool);
  const running=await listen(createHttpApp({pool,apiKey:'prefix-test-secret'}));server=running.server;
  const call=async(method,path,body,extra={})=>{
    const r=await fetch(running.base+path,{method,headers:{'X-API-Key':'prefix-test-secret',...(body!==undefined?{'Content-Type':'application/json'}:{}),...extra},body:body===undefined?undefined:JSON.stringify(body)});
    return{status:r.status,body:await r.json(),retry:r.headers.get('retry-after')};
  };
  const slots=Array.from({length:5},(_,i)=>({id:`s${i}`,provider:'Dr Demo',start:new Date(Date.now()+86400000+i*1800000).toISOString(),end:new Date(Date.now()+86400000+(i+1)*1800000).toISOString()}));
  assert.equal((await call('POST','/api/reset',{slots})).status,200);
  assert.deepEqual((await call('GET','/api/slots')).body,(await call('GET','/slots')).body);
  const attempts=await Promise.all(Array.from({length:8},(_,i)=>call('POST','/api/bookings',{slot_id:'s0',name:`Race ${i}`,email:`race${i}@example.com`})));
  assert.equal(attempts.filter(r=>r.status===201).length,1);assert.equal(attempts.filter(r=>r.status===409).length,7);
  const winner=attempts.find(r=>r.status===201).body;
  assert.deepEqual((await call('GET',`/api/bookings/${winner.id}`)).body,(await call('GET',`/bookings/${winner.id}`)).body);
  assert.equal((await call('DELETE',`/api/bookings/${winner.id}`)).body.status,'cancelled');
  assert.equal((await call('GET','/slots')).body.slots[0].available,true);
  const body={slot_id:'s1',name:' Demo Person ',email:' DEMO@EXAMPLE.COM '};
  const one=await call('POST','/api/bookings',body,{'Idempotency-Key':'prefix-idempotency'});
  const two=await call('POST','/bookings',body,{'Idempotency-Key':'prefix-idempotency'});
  assert.equal(one.status,201);assert.deepEqual(two,one);assert.equal(one.body.email,'demo@example.com');
  assert.equal((await call('POST','/api/bookings',{...body,name:'changed'},{'Idempotency-Key':'prefix-idempotency'})).status,422);
  assert.equal((await call('POST','/api/bookings',{slot_id:'s2',name:'Demo Person',email:'demo@example.com'})).status,201);
  const p1=await call('GET','/api/bookings?email=DEMO%40EXAMPLE.COM&limit=1');assert.equal(p1.body.bookings.length,1);assert.ok(p1.body.next_cursor);
  const p2=await call('GET',`/api/bookings?email=demo%40example.com&limit=1&cursor=${encodeURIComponent(p1.body.next_cursor)}`);assert.equal(p2.body.bookings.length,1);assert.equal(p2.body.next_cursor,null);assert.notEqual(p1.body.bookings[0].id,p2.body.bookings[0].id);
  for(let i=0;i<5;i++)assert.equal((await call('POST','/api/bookings',{slot_id:'missing',name:'Rate Demo',email:'rate@example.com'})).status,404);
  const throttled=await call('POST','/api/bookings',{slot_id:'missing',name:'Rate Demo',email:'rate@example.com'});assert.equal(throttled.status,429);assert.match(throttled.retry,/^\d+$/);
  assert.equal((await call('POST','/api/reset',{slots})).status,200);assert.equal((await call('GET','/bookings?email=demo%40example.com')).body.bookings.length,0);
});
