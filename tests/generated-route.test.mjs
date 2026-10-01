// CodexBWAI — generated addresses never forward a port before BlastCast owns it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRequire } from 'node:module';
const { createGuestServer } = createRequire(import.meta.url)('../desktop/guests.cjs');
async function port() { const server=http.createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const value=server.address().port;await new Promise(r=>server.close(r));return value; }
const input=port=>({origin:'https://pending.invalid',port,routeType:'tunnel'});
function get(port,host) { return new Promise((resolve,reject)=>{http.get({hostname:'127.0.0.1',port,headers:{host}},r=>{r.resume();resolve(r.statusCode);}).on('error',reject);}); }
test('generated origin is resolved only after the loopback listener is held; readiness stays required',async()=>{
 const p=await port(), server=createGuestServer({probe:async()=>{}});let acquired=false;
 try {const result=await server.configure(input(p),async()=>{acquired=true;assert.equal(await get(p,'other.example'),403);return 'https://generated.lhr.life';});
 assert.equal(acquired,true);assert.equal(result.origin,'https://generated.lhr.life');assert.equal(result.phase,'outside-check');assert.equal(server.invite().ok,false);
 }finally{await server.stop();}
});
test('occupied port never invokes provider acquisition',async()=>{
 const occupied=http.createServer();await new Promise(r=>occupied.listen(0,'127.0.0.1',r));const server=createGuestServer({probe:async()=>{}});let acquired=false;
 try{const result=await server.configure(input(occupied.address().port),async()=>{acquired=true;return 'https://generated.lhr.life';});assert.equal(result.phase,'blocked');assert.equal(acquired,false);}finally{await server.stop();await new Promise(r=>occupied.close(r));}
});
test('stop during address acquisition closes listener and refuses late result',async()=>{
 const p=await port(), server=createGuestServer({probe:async()=>{}});let release,started;
 const acquired=new Promise(r=>started=r);const pending=server.configure(input(p),async()=>{started();return new Promise(r=>release=r);});
 let timer;
 try {
 await Promise.race([acquired,new Promise((_,r)=>{timer=setTimeout(()=>r(Error('provider callback not reached')),1000);})]);
 await server.stop();release('https://late.lhr.life');const result=await pending;assert.equal(result.ok,false);assert.equal(server.status().phase,'off');await assert.rejects(get(p,'late.lhr.life'));
 }finally{clearTimeout(timer);release?.('https://late.lhr.life');await server.stop();}
});
test('provider failure releases the listener and never publishes placeholder',async()=>{
 const p=await port(),server=createGuestServer({probe:async()=>{}});
 try{const result=await server.configure(input(p),async()=>{throw Error('provider denied');});assert.equal(result.ok,false);assert.equal(server.status().phase,'off');await assert.rejects(get(p,'pending.invalid'));}finally{await server.stop();}
});
test('saved helper directly creates invitations without claiming outside proof; optional check expiry keeps it alive',async()=>{
 let clock=0;const p=await port(),server=createGuestServer({probe:async()=>{},monotonicNow:()=>clock});
 const helper={provider:'localhost-run',freeAccountConfirmed:true,relay:{urls:['turn:free.expressturn.com:3478?transport=udp'],username:'fixture',credential:'fixture-password',iceTransportPolicy:'all'}};
 try {await server.configure({...input(p),helper});assert.equal(server.enableSavedInvites().phase,'ready');const invited=server.invite();assert.equal(invited.ok,true);assert.ok(invited.invite.url);assert.equal(invited.readiness.stages.outside,'not-proven');clock=600001;assert.equal(server.status().phase,'ready');assert.equal(server.status().readiness.check,null);assert.equal(server.invite().ok,true);
 }finally{await server.stop();}
});
test('direct/manual configuration cannot opt into the saved helper shortcut',async()=>{
 const p=await port(),server=createGuestServer({probe:async()=>{}});try{await server.configure(input(p));assert.equal(server.enableSavedInvites().ok,false);assert.equal(server.invite().ok,false);}finally{await server.stop();}
});
