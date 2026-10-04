// ClaudeBWAI — the free route (localhost.run) terminates TLS, so the host must acknowledge it; plus the optional pinned host key.
// invites.ts runs against the live DOM at load, so the wizard assertions read compiled dist/ text (the live-DOM sweep is in tests/helper-smoke.cjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp,rm,writeFile,readFile} from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomBytes,createCipheriv,createDecipheriv} from 'node:crypto';
import {createFreeTunnel} from '../desktop/free-tunnel.cjs';
import {createGuestAccess} from '../desktop/guest-access.cjs';
import {createGuestSettings} from '../desktop/guest-settings.cjs';
import {createGuestWizard} from '../desktop/guest-wizard.cjs';

const js = readFileSync(new URL('../dist/invites.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('../dist/index.html', import.meta.url), 'utf8');
const helper = {provider:'localhost-run',freeAccountConfirmed:true,relay:{urls:['turn:relay.expressturn.com:3478?transport=udp'],username:'u',credential:'fixture-only',iceTransportPolicy:'all'}};

class Child extends EventEmitter {
  constructor(){super();this.stdout=new EventEmitter();this.stderr=new EventEmitter();this.pid=1;}
  kill(){queueMicrotask(()=>this.emit('close',0));return true;}
}
async function tunnelFixture(t,options={}){
  const directory=await mkdtemp(path.join(tmpdir(),'blastcast-privacy-'));const calls=[];
  const tunnel=createFreeTunnel({directory,startupTimeoutMs:1000,stopTimeoutMs:10,...options,spawn:(...a)=>{calls.push(a);return new Child();}});
  t.after(async()=>{await tunnel.stop();await rm(directory,{recursive:true,force:true});});
  return {directory,tunnel,calls};
}
const until=async fn=>{for(let i=0;i<500;i++){if(fn())return;await new Promise(r=>setTimeout(r,2));}throw Error('fixture timeout');};

test('the free tunnel refuses to start without the privacy acknowledgement and spawns nothing',async t=>{
  const f=await tunnelFixture(t);
  for(const options of [undefined,{},{privacyAcknowledged:false},{privacyAcknowledged:'true'},{privacyAcknowledged:1}]){
    const r=await f.tunnel.start(43821,options);assert.equal(r.ok,false);assert.match(r.message,/privacy notice/);
  }
  assert.equal(f.calls.length,0);assert.equal(f.tunnel.status().phase,'off');
});

test('guest access cannot reach the tunnel without the acknowledgement',async()=>{
  const log=[];
  const tunnel={start:async()=>{log.push('tunnel-start');return {ok:false,message:'x'};},stop:async()=>({ok:true})};
  const guests={revoke(){},stop:async()=>{},configure:async()=>{log.push('configure');return {ok:false};},status:()=>({ok:true,phase:'off'})};
  const access=createGuestAccess({guests,directAccess:{stop:async()=>({ok:true})},tunnel});
  for(const input of [{port:43821,helper},{port:43821,helper,privacyAcknowledged:false},{port:43821,helper,privacyAcknowledged:'yes'}]){
    assert.equal((await access.startFree(input)).ok,false);
  }
  assert.deepEqual(log,[]);
});

test('the saved-setup path will not start the free address unless the saved settings carry the acknowledgement',async()=>{
  let starts=0;let config={domain:'no',origin:'',port:43821,helper};
  const settings={load:async()=>({ok:true,settings:config}),configuration:async()=>config};
  const access={status:()=>({ok:true,phase:'off'}),startFree:async()=>{starts++;return {ok:true,phase:'outside-check'};},configure:async()=>({ok:true,phase:'outside-check'}),stop:async()=>({ok:true})};
  const guests={enableSavedInvites:()=>({ok:true}),invite:()=>({ok:true})};
  const wizard=createGuestWizard({settings,access,guests});
  const refused=await wizard.generate();assert.equal(refused.ok,false);assert.match(refused.message,/privacy notice/);assert.equal(starts,0);
  config={...config,freeRouteAcknowledged:true};assert.equal((await wizard.generate()).ok,true);assert.equal(starts,1);
});

function crypt(){const key=randomBytes(32);return {isEncryptionAvailable:()=>true,getSelectedStorageBackend:()=>'gnome_libsecret',
  encryptString(v){const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',key,iv);const b=Buffer.concat([c.update(v,'utf8'),c.final()]);return Buffer.concat([iv,c.getAuthTag(),b]);},
  decryptString(b){const d=createDecipheriv('aes-256-gcm',key,b.subarray(0,12));d.setAuthTag(b.subarray(12,28));return Buffer.concat([d.update(b.subarray(28)),d.final()]).toString('utf8');}};}
test('guest settings: the main process refuses to save a free-address setup without the tick; the tick persists; forgetting clears it',async t=>{
  const directory=await mkdtemp(path.join(tmpdir(),'blastcast-privacy-settings-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const store=createGuestSettings({directory,safeStorage:crypt()});
  const free=extra=>({domain:'no',origin:'',port:43821,helper,...extra});
  for(const input of [free(),free({freeRouteAcknowledged:false}),free({freeRouteAcknowledged:'true'})]){
    const r=await store.save(input);assert.equal(r.ok,false);
  }
  assert.deepEqual(await store.load(),{ok:true,settings:null});
  const ok=await store.save(free({freeRouteAcknowledged:true}));assert.equal(ok.ok,true);assert.equal(ok.settings.freeRouteAcknowledged,true);
  assert.equal((await store.configuration()).freeRouteAcknowledged,true);
  assert.deepEqual(await store.clear(),{ok:true,settings:null});
  assert.deepEqual(await store.load(),{ok:true,settings:null});
  const own=await store.save({domain:'yes',origin:'https://guests.example.com',port:43821,helper:{...helper,provider:'cloudflare'}});
  assert.equal(own.ok,true);assert.equal(own.settings.freeRouteAcknowledged,false);
});

test('wizard: Save & generate is disabled on the free route until the box is ticked, and the notice is verbatim',()=>{
  assert.match(html,/id="free-privacy-ack" type="checkbox"> I understand\. Use the free address anyway\./);
  assert.ok(html.includes("Privacy:</strong> localhost.run, the free address service, can see guest names, invite links and guests' recordings while they upload. The live call's audio and video stay encrypted end to end. For private recordings, use your own domain with Cloudflare (Cloudflare can see the same traffic, under its own privacy terms)."));
  assert.match(html,/id="free-privacy" class="privacy-warning"/);
  assert.match(js,/save-guest-settings'\)\.disabled = busy \|\| freeUntick/);
  assert.match(js,/freeUntick = !domain && !el\('free-privacy-ack'\)\.checked/);
  assert.match(js,/domain === 'no' && !el\('free-privacy-ack'\)\.checked\) \{\s*wizardError/);
  assert.match(js,/freeRouteAcknowledged: helper\.provider === 'localhost-run' && el\('free-privacy-ack'\)\.checked/);
  assert.match(js,/free-privacy-ack'\)\.checked = Boolean\(saved\?\.freeRouteAcknowledged\)/);
  assert.ok(readFileSync(new URL('../dist/studio.css',import.meta.url),'utf8').includes('.privacy-warning{'));
});

test('wizard: the Cloudflare route shows its grey line and the free route hides it',()=>{
  assert.match(html,/id="cloudflare-privacy-note" class="small field-help">Cloudflare carries this traffic and can see it, under its privacy terms\.<\/p>/);
  assert.match(js,/el\('cloudflare-privacy-note'\)\.hidden = !domain/);
});

test('pinned host key: the ssh args are strict and use the shipped file; a missing or empty file refuses and spawns nothing',async t=>{
  const shipped=path.join(await mkdtemp(path.join(tmpdir(),'blastcast-pin-')),'localhost-run-known-hosts.txt');
  t.after(()=>rm(path.dirname(shipped),{recursive:true,force:true}));
  await writeFile(shipped,'localhost.run ssh-ed25519 AAAAFIXTUREONLY\n');
  const pinned=await tunnelFixture(t,{shippedKnownHosts:shipped});
  void pinned.tunnel.start(43821,{privacyAcknowledged:true});await until(()=>pinned.calls.length===1);
  const args=pinned.calls[0][1];
  assert.ok(args.includes('StrictHostKeyChecking=yes'));assert.ok(!args.includes('StrictHostKeyChecking=accept-new'));
  assert.ok(args.includes(`UserKnownHostsFile="${shipped}"`));assert.ok(args.includes('GlobalKnownHostsFile=none'));
  assert.equal(await readFile(shipped,'utf8'),'localhost.run ssh-ed25519 AAAAFIXTUREONLY\n');

  const empty=path.join(path.dirname(shipped),'empty.txt');await writeFile(empty,'  \n');
  for(const file of [path.join(path.dirname(shipped),'absent.txt'),empty]){
    const f=await tunnelFixture(t,{shippedKnownHosts:file});
    const result=await f.tunnel.start(43821,{privacyAcknowledged:true});
    assert.equal(result.ok,false);assert.match(result.message,/host key file is missing; reinstall BlastCast/);
    assert.equal(f.calls.length,0);
    assert.equal(f.tunnel.status().phase,'failed');
  }
  const real=await tunnelFixture(t);
  void real.tunnel.start(43821,{privacyAcknowledged:true});await until(()=>real.calls.length===1);
  assert.ok(real.calls[0][1].includes('StrictHostKeyChecking=yes'));
});
