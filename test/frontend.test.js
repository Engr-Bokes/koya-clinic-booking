'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');

// A minimal DOM harness exercises the shipped event handlers without dependencies.
// Real browser validity and visual states are also verified before deployment.
function loadFrontend(savedKey = null) {
  class Element {
    constructor(tag = 'div') { this.tagName=tag.toUpperCase();this.value='';this.disabled=false;this.checked=false;this.hidden=false;this.textContent='';this.children=[];this.listeners=new Map();this.attributes={}; }
    get validity() { return {valid:this.type!=='email'||!this.value||/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(this.value.trim())}; }
    addEventListener(type,fn) { if(!this.listeners.has(type))this.listeners.set(type,[]);this.listeners.get(type).push(fn); }
    async dispatch(type) { for(const fn of this.listeners.get(type)||[]) await fn({preventDefault(){}}); }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children=[...children]; }
    setAttribute(key,value) { this.attributes[key]=value; }
    focus() {}
  }
  const html=fs.readFileSync(path.join(__dirname,'../public/index.html'),'utf8');
  const elements=new Map();for(const match of html.matchAll(/<([a-z]+)\b[^>]*\bid="([^"]+)"[^>]*>/g)){
    const el=new Element(match[1]);el.disabled=/\bdisabled\b/.test(match[0]);el.type=match[0].match(/\btype="([^"]+)"/)?.[1];elements.set(match[2],el);
  }
  const calls=[];const slots=[{id:'future',provider:'Dr Demo',start:new Date(Date.now()+86400000).toISOString(),end:new Date(Date.now()+88200000).toISOString(),available:true}];
  const context={document:{getElementById:id=>{assert.ok(elements.has(id),`Unknown field ${id}`);return elements.get(id);},createElement:tag=>new Element(tag)},sessionStorage:{getItem:()=>savedKey,setItem(){},removeItem(){}},fetch:async(url,options)=>{calls.push({url,method:options.method});assert.equal(url,'/api/slots','Invalid or incomplete forms must not make a booking/lookup request');return{ok:true,status:200,headers:{get:()=>null},json:async()=>({slots})};},AbortController,Intl,Date,Map,Set,JSON,URLSearchParams,Uint8Array,crypto:webcrypto,setTimeout,clearTimeout,setInterval,clearInterval};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../public/app.js'),'utf8'),context);
  return{elements,calls,async input(id,value,event='input'){elements.get(id).value=value;await elements.get(id).dispatch(event);}};
}

test('form buttons require trimmed fields, valid email and a selected slot, and react to clearing',async()=>{
  const ui=loadFrontend();const el=id=>ui.elements.get(id);
  assert.equal(el('connect-button').disabled,true);assert.equal(el('book-button').disabled,true);assert.equal(el('lookup-button').disabled,true);
  assert.match(el('access-ready-hint').textContent,/Enter your API key/);
  await ui.input('api-key','   ');assert.equal(el('connect-button').disabled,true);
  await ui.input('api-key','test-key');assert.equal(el('connect-button').disabled,false);
  await ui.input('api-key','');assert.equal(el('connect-button').disabled,true);
  await el('access-form').dispatch('submit');assert.equal(ui.calls.length,0);
  await ui.input('api-key','test-key','change');await el('access-form').dispatch('submit');assert.equal(ui.calls.length,1);
  assert.equal(el('filter-button').disabled,false,'Blank provider is optional and can show all providers');
  assert.equal(el('lookup-button').disabled,true);assert.equal(el('book-button').disabled,true);
  await ui.input('patient-name','Alex Demo');await ui.input('patient-email','alex@example.com');assert.equal(el('book-button').disabled,true,'A slot is required too');
  const radio=el('slots-list').children[0].children[0];await radio.dispatch('change');assert.equal(el('book-button').disabled,false);
  await ui.input('patient-name','   ');assert.equal(el('book-button').disabled,true);
  await el('booking-form').dispatch('submit');assert.equal(ui.calls.length,1,'Programmatic submit cannot bypass readiness');
  await ui.input('patient-name','Alex Demo');assert.equal(el('book-button').disabled,false);
  await ui.input('patient-email','');assert.equal(el('book-button').disabled,true);
  await ui.input('patient-email','bad-address');assert.equal(el('book-button').disabled,true);assert.match(el('booking-ready-hint').textContent,/valid email/);
  await ui.input('patient-email','alex@localhost');assert.equal(el('book-button').disabled,true);
  await ui.input('patient-email','alex@example.com','change');assert.equal(el('book-button').disabled,false);assert.match(el('booking-ready-hint').textContent,/All required details/);
  await ui.input('booking-id','   ');assert.equal(el('lookup-button').disabled,true);
  await el('lookup-form').dispatch('submit');assert.equal(ui.calls.length,1);
  await ui.input('booking-id','booking-reference');assert.equal(el('lookup-button').disabled,false);
  await ui.input('booking-id','');assert.equal(el('lookup-button').disabled,true);
  await ui.input('api-key','');assert.equal(el('connect-button').disabled,true);
});

test('a restored key enables Connect but not disconnected booking or lookup',()=>{
  const ui=loadFrontend('test-restored-key');const el=id=>ui.elements.get(id);
  assert.equal(el('connect-button').disabled,false);assert.equal(el('remember-key').checked,true);
  assert.equal(el('book-button').disabled,true);assert.equal(el('lookup-button').disabled,true);assert.equal(ui.calls.length,0);
});
