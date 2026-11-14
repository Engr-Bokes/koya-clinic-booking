'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');
const root=path.join(__dirname,'..');
test('favicon SVG and bitmap fallback have the expected CareSlot branding and formats',()=>{
  const svg=fs.readFileSync(path.join(root,'public/favicon.svg'),'utf8');assert.match(svg,/viewBox="0 0 64 64"/);assert.match(svg,/#125f58/);assert.match(svg,/<title>CareSlot<\/title>/);assert.ok(!svg.includes('<script'));
  const ico=fs.readFileSync(path.join(root,'public/favicon.ico'));assert.equal(ico.readUInt16LE(2),1);assert.equal(ico.readUInt16LE(4),1);assert.equal(ico[6],32);assert.equal(ico[7],32);assert.deepEqual([...ico.subarray(22,30)],[137,80,78,71,13,10,26,10]);
  const apple=fs.readFileSync(path.join(root,'public/apple-touch-icon.png'));assert.equal(apple.readUInt32BE(16),180);assert.equal(apple.readUInt32BE(20),180);
});
test('patient page and documentation both declare favicon and touch icon links',()=>{for(const p of ['public/index.html','public/docs.html']){const html=fs.readFileSync(path.join(root,p),'utf8');assert.match(html,/rel="icon" href="\/favicon.ico"/);assert.match(html,/rel="icon" href="\/favicon.svg" type="image\/svg\+xml"/);assert.match(html,/rel="apple-touch-icon" href="\/apple-touch-icon.png"/);}});
test('favicon assets are static routes before the authenticated API catch-all',()=>{const config=JSON.parse(fs.readFileSync(path.join(root,'vercel.json'),'utf8'));for(const asset of ['favicon.svg','favicon.ico','apple-touch-icon.png']){const matching=config.routes.findIndex(r=>new RegExp('^'+r.src+'$').test('/'+asset));assert.ok(matching>=0);assert.equal(config.routes[matching].dest,'/public/$1');assert.ok(matching<config.routes.findIndex(r=>r.src==='/(.*)'));}});
