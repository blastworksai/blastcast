// CodexBWAI — saved setup lifecycle, no live provider or native credentials.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createGuestWizard} from '../desktop/guest-wizard.cjs';
function fixture(){
 let config={domain:'no',freeRouteAcknowledged:true,origin:'',port:43821,helper:{}},state={ok:true,phase:'off'},recording=false,starts=0,invites=0;
 const settings={load:async()=>({ok:true,settings:config}),configuration:async()=>config,save:async c=>{config=c;return{ok:true,settings:c};},clear:async()=>{config=null;return{ok:true,settings:null};}};
 const access={status:()=>state,startFree:async()=>{starts++;return state={ok:true,phase:'outside-check'};},configure:async()=>{starts++;return state={ok:true,phase:'outside-check'};},stop:async()=>state={ok:true,phase:'off'}};
 const guests={enableSavedInvites:()=>state={ok:true,phase:'ready'},invite:()=>({...state,invite:{url:`https://example.test/#${++invites}`}})};
 return {wizard:createGuestWizard({settings,access,guests,busy:()=>recording}),settings,access,get starts(){return starts;},get invites(){return invites;},record:()=>{recording=true;}};
}
test('saved setup starts once; later links reuse route, including during recording',async()=>{const f=fixture();assert.equal((await f.wizard.generate()).ok,true);assert.equal(f.starts,1);f.record();assert.equal((await f.wizard.generate()).ok,true);assert.equal(f.starts,1);assert.equal(f.invites,2);});
test('changed settings restart route; forgetting stops access and requires setup',async()=>{const f=fixture();await f.wizard.generate();await f.wizard.save({domain:'yes',origin:'https://own.example',port:43821,helper:{}});await f.wizard.generate();assert.equal(f.starts,2);await f.wizard.clear();assert.equal((await f.wizard.generate()).ok,false);assert.equal(f.access.status().phase,'off');});
test('recording blocks starting connections and changing saved settings',async()=>{const f=fixture();f.record();assert.equal((await f.wizard.generate()).ok,false);assert.equal((await f.wizard.save({})).ok,false);assert.equal((await f.wizard.clear()).ok,false);assert.equal(f.starts,0);});
test('external stop invalidates pending settings read; concurrent generate does not duplicate',async()=>{const f=fixture();let resolve;f.settings.configuration=()=>new Promise(r=>resolve=r);const first=f.wizard.generate();assert.equal((await f.wizard.generate()).ok,false);f.wizard.invalidate();resolve({domain:'no'});assert.equal((await first).ok,false);assert.equal(f.starts,0);});
