// CodexBWAI — automation is scoped to the current setup and one readiness success.
import test from 'node:test';import assert from 'node:assert/strict';
import {InviteAutomation} from '../dist/invite-automation.js';
const status=(phase,origin='https://current.example',invite=null)=>({ok:true,phase,origin,invite});
test('only explicitly started setup creates one invitation after outside readiness',()=>{
 const auto=new InviteAutomation();assert.equal(auto.take(status('ready')),false);
 const setup=auto.begin();auto.accept(setup,status('outside-check'));
 for(const phase of ['checking','outside-check','outside-check'])assert.equal(auto.take(status(phase)),false);
 assert.equal(auto.take(status('ready')),true);
 for(let i=0;i<5;i++)assert.equal(auto.take(status('ready')),false);
 // Revocation/expiry cannot recreate invitations on later polls.
 assert.equal(auto.take(status('ready','https://current.example',{expiresAt:0})),false);
});
test('cancelled/reconfigured setup ignores stale success and different origins',()=>{
 const auto=new InviteAutomation();const stale=auto.begin();auto.cancel();auto.accept(stale,status('ready'));assert.equal(auto.take(status('ready')),false);
 const old=auto.begin();const current=auto.begin();auto.accept(old,status('ready'));assert.equal(auto.take(status('ready')),false);
 auto.accept(current,status('outside-check'));assert.equal(auto.take(status('ready','https://old.example')),false);assert.equal(auto.take(status('ready')),true);
});
test('existing invitation satisfies setup and stopped/blocked setup stays stopped',()=>{
 const auto=new InviteAutomation();auto.accept(auto.begin(),status('ready'));assert.equal(auto.take(status('ready','https://current.example',{expiresAt:200}),100),false);assert.equal(auto.take(status('ready'),300),false);
 for(const phase of ['blocked','off']) {auto.accept(auto.begin(),status('outside-check'));assert.equal(auto.take(status(phase)),false);assert.equal(auto.take(status('ready')),false);}
 auto.accept(auto.begin(),{ok:false});assert.equal(auto.take(status('ready')),false);
});
