// CodexBWAI — lifecycle coordinator uses a held listener and one owned provider child.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const {createGuestAccess}=createRequire(import.meta.url)('../desktop/guest-access.cjs');
const input={port:43821,privacyAcknowledged:true,helper:{provider:'localhost-run',freeAccountConfirmed:true,relay:{urls:['turn:eu.expressturn.com:3478?transport=udp'],username:'test',credential:'fixture-only',iceTransportPolicy:'all'}}};
function fixture(overrides={}) {
 const order=[];let phase='off';
 const guests={revoke:()=>order.push('revoke'),stop:async()=>{order.push('listener-stop');phase='off';},status:()=>({ok:true,phase,invite:null}),configure:async(config,origin)=>{order.push('listener-bound');if(origin)config={...config,origin:await origin(config.port)};phase='outside-check';return {ok:true,phase,origin:config.origin};},...overrides.guests};
 const tunnel={stop:async()=>{order.push('tunnel-stop');return {ok:true};},start:async()=>{order.push('tunnel-start');return {ok:true,origin:'https://fixture.lhr.life'};},...overrides.tunnel};
 const access=createGuestAccess({guests,tunnel,directAccess:{stop:async()=>{order.push('direct-stop');return {ok:true};}},onConfigured:()=>order.push('configured')});
 return {access,order};
}
test('no-domain setup binds before forwarding and stops forwarding before releasing listener',async()=>{
 const {access,order}=fixture();const result=await access.startFree(input);assert.equal(result.origin,'https://fixture.lhr.life');assert.equal(result.phase,'outside-check');assert.deepEqual(order,['revoke','tunnel-stop','listener-stop','direct-stop','listener-bound','tunnel-start','configured']);await access.stop();assert.deepEqual(order.slice(-4),['revoke','tunnel-stop','listener-stop','direct-stop']);
});
test('invalid credentials and extra command input cause no cleanup or network activity',async()=>{
 for(const value of [{...input,command:'evil'}, {...input,port:22}, {...input,helper:{...input.helper,provider:'cloudflare'}}, {...input,helper:{...input.helper,relay:{...input.helper.relay,credential:''}}}]){const {access,order}=fixture();assert.equal((await access.startFree(value)).ok,false);assert.deepEqual(order,[]);}
});
test('failed child shutdown prevents releasing port or creating replacement',async()=>{
 const {access,order}=fixture({tunnel:{stop:async()=>({ok:false,message:'Child still running'})}});assert.equal((await access.startFree(input)).ok,false);assert.deepEqual(order,['revoke']);
});
test('provider failure is surfaced without claiming an invitation exists',async()=>{
 const {access,order}=fixture({tunnel:{start:async()=>({ok:false,message:'OpenSSH missing'})}});const result=await access.startFree(input);assert.equal(result.message,'OpenSSH missing');assert.equal(access.status().phase,'off');assert.ok(order.includes('listener-stop'));
});
test('stop during setup rejects late address and overlapping setup',async()=>{
 let release,started;const waiting=new Promise(r=>started=r);
 const {access}=fixture({tunnel:{start:async()=>{started();return new Promise(r=>release=r);}}});
 const run=access.startFree(input);await waiting;assert.equal((await access.startFree(input)).ok,false);await access.stop();release({ok:true,origin:'https://late.lhr.life'});assert.equal((await run).ok,false);assert.equal(access.status().phase,'off');
});
test('unexpected tunnel loss closes guest sessions and retains understandable error',async()=>{
 const {access,order}=fixture();await access.startFree(input);await access.lost('Temporary address disconnected.');assert.equal(access.status().phase,'off');assert.equal(access.status().connectionMessage,'Temporary address disconnected.');assert.deepEqual(order.slice(-4),['revoke','tunnel-stop','listener-stop','direct-stop']);
});
test('an omitted privacy flag gets the privacy message, not the generic address one',async()=>{
 const {privacyAcknowledged,...without}=input;
 for(const value of [without,{...input,privacyAcknowledged:false}]){const {access,order}=fixture();const result=await access.startFree(value);assert.equal(result.ok,false);assert.match(result.message,/privacy notice/);assert.deepEqual(order,[]);}
});
