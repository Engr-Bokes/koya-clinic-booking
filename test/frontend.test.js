'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');

// A minimal DOM harness exercises the shipped event handlers without dependencies.
// Real browser validity and visual states are also verified before deployment.
function loadFrontend(savedKey = null, options = {}) {
  let activeElement = null;
  class Element {
    constructor(tag = 'div') { this.tagName=tag.toUpperCase();this.value='';this.disabled=false;this.checked=false;this.hidden=false;this.textContent='';this.children=[];this.listeners=new Map();this.attributes={}; }
    get validity() { return {valid:this.type!=='email'||!this.value||/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(this.value.trim())}; }
    addEventListener(type,fn) { if(!this.listeners.has(type))this.listeners.set(type,[]);this.listeners.get(type).push(fn); }
    async dispatch(type,extra={}) { for(const fn of this.listeners.get(type)||[]) await fn({preventDefault(){},...extra}); }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children=[...children]; }
    setAttribute(key,value) { this.attributes[key]=value; }
    focus(options) { activeElement=this;this.focusOptions=options; }
    scrollIntoView(options) { this.scrollOptions=options; }
  }
  const html=fs.readFileSync(path.join(__dirname,'../public/index.html'),'utf8');
  const elements=new Map();for(const match of html.matchAll(/<([a-z]+)\b[^>]*\bid="([^"]+)"[^>]*>/g)){
    const el=new Element(match[1]);el.disabled=/\bdisabled\b/.test(match[0]);el.type=match[0].match(/\btype="([^"]+)"/)?.[1];elements.set(match[2],el);
  }
  const respond=options.respond;
  const calls=[];const slots=[{id:'future',provider:'Dr Demo',start:new Date(Date.now()+86400000).toISOString(),end:new Date(Date.now()+88200000).toISOString(),available:true}];
  const context={matchMedia:()=>({matches:options.reducedMotion===true}),navigator:options.clipboard?{clipboard:options.clipboard}:{},document:{getElementById:id=>{assert.ok(elements.has(id),`Unknown field ${id}`);return elements.get(id);},createElement:tag=>new Element(tag)},sessionStorage:{getItem:()=>savedKey,setItem(){},removeItem(){}},fetch:async(url,options)=>{calls.push({url,method:options.method});if(respond)return respond(url,options);assert.equal(url,'/api/slots','Invalid or incomplete forms must not make a booking/lookup request');return{ok:true,status:200,headers:{get:()=>null},json:async()=>({slots})};},AbortController,Intl,Date,Map,Set,JSON,URLSearchParams,Uint8Array,crypto:webcrypto,setTimeout,clearTimeout,setInterval,clearInterval};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../public/app.js'),'utf8'),context);
  return{elements,calls,get activeElement(){return activeElement;},async input(id,value,event='input'){elements.get(id).value=value;await elements.get(id).dispatch(event);}};
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

async function setupCopyTest(clipboard) {
  const start=new Date(Date.now()+86400000).toISOString();
  const slots=[{id:'future',provider:'Dr Demo',start,end:new Date(Date.now()+88200000).toISOString(),available:true}];
  const ui=loadFrontend(null,{clipboard,respond:async(url)=>{
    let data;
    if(url==='/api/slots')data={slots};
    else if(url.startsWith('/api/bookings/')){const id=decodeURIComponent(url.split('/').pop());data={id,slot_id:'future',name:'Demo Person',email:'demo@example.com',status:id==='booking-two'?'cancelled':'confirmed',created_at:new Date().toISOString()};}
    else throw Error('Unexpected copy-test request: '+url);
    return{ok:true,status:200,headers:{get:()=>null},json:async()=>data};
  }});
  await ui.input('api-key','private-test-key');await ui.elements.get('access-form').dispatch('submit');
  await ui.input('booking-id','booking-one');await ui.elements.get('lookup-form').dispatch('submit');
  return ui;
}

test('copy control copies exactly the displayed booking ID and resets for another booking',async()=>{
  const copied=[];const ui=await setupCopyTest({writeText:async text=>copied.push(text)});const el=id=>ui.elements.get(id);
  assert.equal(el('confirmed-reference').textContent,'booking-one');assert.equal(el('copy-reference-button').disabled,false);
  await el('copy-reference-button').dispatch('click');assert.deepEqual(copied,['booking-one']);assert.equal(el('copy-reference-button').textContent,'Copied');assert.match(el('copy-reference-message').textContent,/reference copied/);
  await el('refresh-button').dispatch('click');assert.equal(el('copy-reference-button').textContent,'Copied');
  await ui.input('booking-id','booking-two');await el('lookup-form').dispatch('submit');assert.equal(el('confirmed-reference').textContent,'booking-two');assert.equal(el('copy-reference-button').textContent,'Copy reference');assert.equal(el('copy-reference-message').textContent,'');
  await el('copy-reference-button').dispatch('click');assert.deepEqual(copied,['booking-one','booking-two']);assert.equal(el('copy-reference-button').textContent,'Copied');
});

for(const [label,clipboard] of [['permission denied',{writeText:async()=>{throw Error('permission denied');}}],['API unavailable',null]]){
  test(`copy control gives manual instructions without false success when clipboard ${label}`,async()=>{
    const ui=await setupCopyTest(clipboard);const el=id=>ui.elements.get(id);
    await el('copy-reference-button').dispatch('click');assert.equal(el('copy-reference-button').textContent,'Copy reference');assert.equal(el('copy-reference-button').disabled,false);assert.match(el('copy-reference-message').textContent,/blocked by your browser/);assert.match(el('copy-reference-message').textContent,/Cmd\+C/);assert.match(el('copy-reference-message').className,/error/);assert.equal(el('confirmed-reference').textContent,'booking-one');
  });
}

test('pending copy is disabled and never reports an old ID as copied for a new booking',async()=>{
  let resolveCopy;const ui=await setupCopyTest({writeText:()=>new Promise(resolve=>{resolveCopy=resolve;})});const el=id=>ui.elements.get(id);
  const pending=el('copy-reference-button').dispatch('click');assert.equal(el('copy-reference-button').disabled,true);assert.equal(el('copy-reference-button').textContent,'Copying…');
  await ui.input('booking-id','booking-two');await el('lookup-form').dispatch('submit');resolveCopy();await pending;
  assert.equal(el('confirmed-reference').textContent,'booking-two');assert.equal(el('copy-reference-button').textContent,'Copy reference');assert.equal(el('copy-reference-message').textContent,'');assert.equal(el('copy-reference-button').disabled,false);
});

async function setupSlotFocus(options={}) {
  const ui=loadFrontend(null,options);await ui.input('api-key','test-key');await ui.elements.get('access-form').dispatch('submit');return ui;
}
test('selecting a slot brings the booking panel into view and focuses the name field',async()=>{
  const ui=await setupSlotFocus();const el=id=>ui.elements.get(id);const radio=el('slots-list').children[0].children[0];
  await radio.dispatch('change');assert.equal(ui.activeElement,el('patient-name'));assert.equal(el('booking-panel').scrollOptions.behavior,'smooth');assert.equal(el('booking-panel').scrollOptions.block,'start');assert.equal(el('patient-name').focusOptions.preventScroll,true);assert.equal(el('booking-fields').disabled,false);assert.equal(el('book-button').disabled,true);assert.equal(ui.calls.length,1,'Selecting a slot never submits a booking');assert.equal(radio.attributes['aria-controls'],'booking-form');
});
test('slot navigation preserves entered values and focuses email or confirmation as appropriate',async()=>{
  const ui=await setupSlotFocus();const el=id=>ui.elements.get(id);const radio=el('slots-list').children[0].children[0];
  await ui.input('patient-name','Alex Demo');await radio.dispatch('change');assert.equal(ui.activeElement,el('patient-email'));assert.equal(el('patient-name').value,'Alex Demo');
  await ui.input('patient-email','alex@example.com');await radio.dispatch('change');assert.equal(ui.activeElement,el('book-button'));assert.equal(el('patient-email').value,'alex@example.com');assert.equal(el('book-button').disabled,false);assert.equal(ui.calls.length,1);
});
test('slot navigation respects reduced motion and does not steal focus during arrow-key browsing',async()=>{
  const ui=await setupSlotFocus({reducedMotion:true});const el=id=>ui.elements.get(id);const radio=el('slots-list').children[0].children[0];
  radio.focus();await radio.dispatch('keydown',{key:'ArrowDown'});await radio.dispatch('change');assert.equal(ui.activeElement,radio);assert.equal(el('booking-panel').scrollOptions,undefined);
  await radio.dispatch('pointerdown');await radio.dispatch('change');assert.equal(ui.activeElement,el('patient-name'));assert.equal(el('booking-panel').scrollOptions.behavior,'auto');assert.equal(ui.calls.length,1);
});
