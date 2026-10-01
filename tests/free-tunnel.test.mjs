// CodexBWAI — no live service: fake owned OpenSSH child and private temporary config.
import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp,readFile,stat,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createFreeTunnel,parseOrigin} from '../desktop/free-tunnel.cjs';
class Child extends EventEmitter {
 constructor(){super();this.stdout=new EventEmitter();this.stderr=new EventEmitter();this.pid=1234;this.kills=[];}
 kill(signal){this.kills.push(signal);queueMicrotask(()=>this.emit('close',0));return true;}
 output(value){this.stdout.emit('data',Buffer.from(value));}
}
const line=host=>`${host} tunneled with tls termination, https://${host}\n`;
async function fixture(t,options={}){
 const directory=await mkdtemp(path.join(tmpdir(),'blastcast-tunnel-'));const calls=[];let child;
 const tunnel=createFreeTunnel({directory,startupTimeoutMs:1000,stopTimeoutMs:10,...options,spawn:(...args)=>{child=new Child();calls.push(args);return child;}});
 t.after(async()=>{await tunnel.stop();await rm(directory,{recursive:true,force:true});});
 return {directory,tunnel,calls,get child(){return child;}};
}
async function until(fn){for(let i=0;i<1000;i++){if(fn())return;await new Promise(r=>setTimeout(r,2));}throw Error('fixture timeout');}
test('only exact provider announcement with an origin is accepted',()=>{
 for(const host of ['abc-12.lhr.life','abc.localhost.run'])assert.equal(parseOrigin(line(host).trim()),`https://${host}`);
 for(const value of ['https://abc.lhr.life','https://admin.localhost.run',line('evil.example').trim(),'abc.lhr.life tunneled with tls termination, https://abc.lhr.life/path','abc.lhr.life tunneled with tls termination, https://user@abc.lhr.life','abc.lhr.life tunneled with tls termination, https://abc.lhr.life:443','abc.lhr.life tunneled with tls termination, https://abc.lhr.life\u0000','abc.lhr.life tunneled with tls termination, https://other.lhr.life'])assert.equal(parseOrigin(value),null);
});
test('bounded fixed SSH arguments, isolated trust/config, no credentials, retained host key',async t=>{
 const f=await fixture(t);const result=f.tunnel.start(43821);await until(()=>f.child);const [exe,args,opts]=f.calls[0];
 assert.equal(exe,'/usr/bin/ssh');assert.equal(opts.shell,false);assert.equal(opts.env.SSH_AUTH_SOCK,undefined);assert.equal(opts.env.SSH_ASKPASS_REQUIRE,'never');
 for(const arg of ['IdentityAgent=none','IdentityFile=none','PubkeyAuthentication=no','PasswordAuthentication=no','KbdInteractiveAuthentication=no','PreferredAuthentications=none','StrictHostKeyChecking=accept-new','GlobalKnownHostsFile=none','80:127.0.0.1:43821','nokey@localhost.run'])assert.ok(args.includes(arg),arg);
 assert.equal(await readFile(path.join(f.directory,'ssh-config'),'utf8'),'');assert.equal((await stat(f.directory)).mode&0o777,0o700);
 f.child.output('abc.lhr.life tunneled with tls termination, https://abc.');f.child.output('lhr.life\n');assert.deepEqual(await result,{ok:true,origin:'https://abc.lhr.life'});
 await writeFile(path.join(f.directory,'known-hosts'),'fixture trusted key');assert.equal((await f.tunnel.stop()).ok,true);
 const again=f.tunnel.start(43821);await until(()=>f.calls.length===2);assert.equal(await readFile(path.join(f.directory,'known-hosts'),'utf8'),'fixture trusted key');await f.tunnel.stop();assert.equal((await again).ok,false);
});
test('invalid ports spawn nothing; concurrent starts cannot replace owned child',async t=>{
 const f=await fixture(t);for(const port of [0,80,1023,65536,1.5,'43821'])assert.equal((await f.tunnel.start(port)).ok,false);
 assert.equal(f.calls.length,0);const pending=f.tunnel.start(43821);await until(()=>f.child);assert.equal((await f.tunnel.start(43822)).ok,false);await f.tunnel.stop();assert.equal((await pending).ok,false);
});
test('cancel before filesystem preparation completes prevents any late child',async t=>{
 const f=await fixture(t);const pending=f.tunnel.start(43821);await f.tunnel.stop();assert.equal((await pending).ok,false);await new Promise(r=>setTimeout(r,30));assert.equal(f.calls.length,0);assert.equal(f.tunnel.status().phase,'off');
});
test('owned child stop ignores late announcements and does not notify loss',async t=>{
 const lost=[];const f=await fixture(t,{onLost:m=>lost.push(m)});const pending=f.tunnel.start(43821);await until(()=>f.child);f.child.output(line('abc.lhr.life'));await pending;await f.tunnel.stop();f.child.output(line('late.lhr.life'));assert.equal(f.tunnel.status().origin,null);assert.deepEqual(lost,[]);assert.deepEqual(f.child.kills,['SIGTERM']);
});
test('crash clears address and loss callback may stop without deadlock',async t=>{
 let callback;const f=await fixture(t,{onLost:async message=>{assert.equal(typeof message,'string');await f.tunnel.stop();callback=true;}});const pending=f.tunnel.start(43821);await until(()=>f.child);f.child.output(line('abc.lhr.life'));await pending;f.child.emit('close',1);await until(()=>callback);assert.equal(f.tunnel.status().origin,null);
});
test('key change is denied without replacing trust file or returning raw output',async t=>{
 const f=await fixture(t);const pending=f.tunnel.start(43821);await until(()=>f.child);await writeFile(path.join(f.directory,'known-hosts'),'oldkey');f.child.output('WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! secret-payload\n');const result=await pending;assert.equal(result.ok,false);assert.match(result.message,/SSH host key/);assert.ok(!result.message.includes('secret-payload'));assert.equal(await readFile(path.join(f.directory,'known-hosts'),'utf8'),'oldkey');
});
test('output flood, startup timeout, address rotation fail closed',async t=>{
 const f=await fixture(t);let result=f.tunnel.start(43821);await until(()=>f.child);f.child.output('x'.repeat(65537));assert.equal((await result).ok,false);await until(()=>f.child.kills.length>0);await f.tunnel.stop();
 const timed=await fixture(t,{startupTimeoutMs:25});assert.match((await timed.tunnel.start(43821)).message,/in time/);await timed.tunnel.stop();
 result=f.tunnel.start(43821);await until(()=>f.calls.length===2);f.child.output(line('first.lhr.life'));assert.equal((await result).ok,true);f.child.output(line('second.lhr.life'));assert.equal(f.tunnel.status().origin,null);assert.equal(f.tunnel.status().phase,'failed');
});
test('Windows selects absolute system OpenSSH and missing executable is actionable',async t=>{
 const f=await fixture(t,{platform:'win32'});const pending=f.tunnel.start(43821);await until(()=>f.child);
 assert.equal(f.calls[0][0],path.win32.join(process.env.SystemRoot||'C:\\Windows','System32','OpenSSH','ssh.exe'));f.child.pid=undefined;f.child.emit('error',Object.assign(new Error('private detail'),{code:'ENOENT'}));assert.match((await pending).message,/OpenSSH is not installed/);assert.equal(f.tunnel.status().origin,null);
});
test('unresponsive owned child is escalated and replacement blocked until confirmed close',async t=>{
 const f=await fixture(t);const pending=f.tunnel.start(43821);await until(()=>f.child);f.child.kill=signal=>{f.child.kills.push(signal);return true;};f.child.output(line('abc.lhr.life'));await pending;
 const stopped=await f.tunnel.stop();assert.equal(stopped.ok,false);assert.deepEqual(f.child.kills,['SIGTERM','SIGKILL']);assert.equal((await f.tunnel.start(43821)).ok,false);f.child.emit('close',0);assert.equal(f.tunnel.status().origin,null);
});
