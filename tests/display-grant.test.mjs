// ClaudeBWAI — host display consent: a desktop grant exists only for a pick armed in the isolated picker, is spent once,
// is served only by the display-media handler, and a grant spent anywhere else crashes the studio renderer.
import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createDisplayPermission,createChooseScreen,STUDIO_URL} from '../desktop/boundary.cjs';
function permissionFixture(overrides={}){
 const contents=new EventEmitter();contents.getURL=()=>STUDIO_URL;let clock=1000;let allowed=false,active=true;
 const timers=[],crashed=[],logs=[];
 const dp=createDisplayPermission({getContents:()=>contents,authorized:()=>active,deviceAllowed:()=>allowed,now:()=>clock,
  setTimer:(fn,ms)=>{const timer={fn,ms,live:true};timers.push(timer);return timer;},clearTimer:timer=>{timer.live=false;},
  onUnconsumed:c=>crashed.push(c),log:m=>logs.push(m),...overrides});dp.watch(contents);
 const details={isMainFrame:true,mediaTypes:[],requestingUrl:STUDIO_URL,securityOrigin:'app://studio/'};
 const fire=()=>{for(const timer of timers.splice(0))if(timer.live){timer.live=false;timer.fn();}};
 return {contents,dp,details,timers,crashed,logs,fire,tick:ms=>{clock+=ms;},input:type=>contents.emit('input-event',{},{type}),allow:v=>{allowed=v;},activate:v=>{active=v;}};
}
const screen={id:'screen:1:0',name:'Entire screen'};
test('no armed pick: an empty-mediaTypes request is refused even right after a genuine input, with or without camera consent',()=>{
 for(const consent of [false,true]){const f=permissionFixture();f.allow(consent);
  f.input('mouseDown');f.input('mouseUp');assert.equal(f.dp.request(f.contents,'media',f.details),false,`consent=${consent}`);
  assert.equal(f.dp.request(f.contents,'display-capture',f.details),false);assert.equal(f.timers.length,0);}
});
test('an armed pick is granted once; a second request is refused',()=>{
 const f=permissionFixture();f.dp.arm(screen);
 assert.equal(f.dp.request(f.contents,'media',f.details),true,'armed, needs no camera consent and no fresh input');
 assert.equal(f.dp.request(f.contents,'media',f.details),false,'one pick buys one grant');
 assert.equal(f.timers.length,1);assert.equal(f.timers[0].ms,1500,'watchdog started with the grant');
});
test('an expired pick (more than 5 s) is refused',()=>{
 const f=permissionFixture();f.dp.arm(screen);f.tick(5001);assert.equal(f.dp.request(f.contents,'media',f.details),false);
 const g=permissionFixture();g.dp.arm(screen);g.tick(5000);assert.equal(g.dp.request(g.contents,'media',g.details),true,'boundary is inclusive');
});
test('an armed grant still needs activation, the studio contents and document, its main frame and its origin',()=>{
 const cases=[[f=>f.activate(false),'unlicensed'],[f=>['media',f.details,{getURL:()=>STUDIO_URL}],'other contents'],[f=>['media',{...f.details,isMainFrame:false}],'subframe'],
  [f=>['media',{...f.details,requestingUrl:'app://studio.evil/'}],'foreign origin'],[f=>['media',{...f.details,mediaTypes:undefined}],'unknown shape'],
  [f=>{f.contents.getURL=()=>'app://studio/other.html';},'not the studio document']];
 for(const [setup,label] of cases){const f=permissionFixture();f.dp.arm(screen);const args=setup(f);const [permission,details,contents]=Array.isArray(args)?args:['media',f.details];
  assert.equal(f.dp.request(contents??f.contents,permission,details),false,label);}
});
test('the display-media handler side serves the armed source once, after its grant, and clears it',()=>{
 const f=permissionFixture();assert.equal(f.dp.serve(),null,'nothing armed');
 f.dp.arm(screen);assert.equal(f.dp.serve(),null,'armed but not granted: getDisplayMedia without its permission grant gets nothing');
 assert.equal(f.dp.request(f.contents,'media',f.details),true);assert.equal(f.dp.serve(),screen);assert.equal(f.dp.serve(),null,'cleared');
 assert.equal(f.timers[0].live,false,'watchdog stopped');f.fire();assert.deepEqual(f.crashed,[]);
 assert.equal(f.dp.request(f.contents,'media',f.details),false,'served pick cannot be granted again');
});
test('a grant not consumed in time crashes the studio renderer and logs one line',()=>{
 const f=permissionFixture();f.dp.arm(screen);assert.equal(f.dp.request(f.contents,'media',f.details),true);
 f.fire();assert.deepEqual(f.crashed,[f.contents]);assert.equal(f.logs.length,1);assert.match(f.logs[0],/spent outside getDisplayMedia/);
 assert.equal(f.dp.serve(),null,'disarmed');assert.equal(f.dp.request(f.contents,'media',f.details),false);
});
test('a stale watchdog from an earlier grant cannot crash a later, served one; a new pick or a studio navigation disarms',()=>{
 const f=permissionFixture();f.dp.arm(screen);f.dp.arm({id:'window:2'});assert.equal(f.timers.length,0);
 assert.equal(f.dp.request(f.contents,'media',f.details),true);assert.equal(f.dp.serve().id,'window:2');f.fire();assert.deepEqual(f.crashed,[]);
 f.dp.arm(screen);f.contents.emit('did-start-navigation',{},STUDIO_URL,true,true);assert.equal(f.dp.request(f.contents,'media',f.details),true,'in-place navigation keeps the pick');
 f.dp.serve();f.dp.arm(screen);f.contents.emit('did-start-navigation',{},STUDIO_URL,false,true);assert.equal(f.dp.request(f.contents,'media',f.details),false,'a reload drops it');
});
test('takeInput spends one genuine input under 2 s on the studio contents; scripted and non-activating input buy nothing',()=>{
 const f=permissionFixture();assert.equal(f.dp.takeInput(f.contents),false,'no input');
 f.input('mouseMove');f.input('gestureScrollBegin');assert.equal(f.dp.takeInput(f.contents),false,'non-activating input');
 f.input('mouseUp');assert.equal(f.dp.takeInput({getURL:()=>STUDIO_URL}),false,'other contents');assert.equal(f.dp.takeInput(f.contents),true);assert.equal(f.dp.takeInput(f.contents),false,'consumed');
 f.input('keyUp');f.tick(2001);assert.equal(f.dp.takeInput(f.contents),false,'stale');
 f.input('rawKeyDown');f.contents.getURL=()=>'app://studio/other.html';assert.equal(f.dp.takeInput(f.contents),false,'not the studio document');
});
function chooser(f,result){
 const picker={active:false,opened:0,async choose(){picker.opened++;return result;}};
 return {picker,choose:createChooseScreen({permission:f.dp,picker,getContents:()=>f.contents})};
}
test('chooseScreen without recent genuine input is refused and opens no picker',async()=>{
 const f=permissionFixture();const c=chooser(f,screen);assert.deepEqual(await c.choose(),{ok:false});
 f.input('mouseUp');f.tick(2001);assert.deepEqual(await c.choose(),{ok:false});assert.equal(c.picker.opened,0);
 assert.equal(f.dp.request(f.contents,'media',f.details),false);
});
test('chooseScreen after input arms the pick; cancel arms nothing; an open picker refuses a second one',async()=>{
 const f=permissionFixture();const c=chooser(f,screen);f.input('mouseUp');assert.deepEqual(await c.choose(),{ok:true});assert.equal(c.picker.opened,1);
 assert.equal(f.dp.request(f.contents,'media',f.details),true);assert.equal(f.dp.serve(),screen);
 const cancelled=chooser(f,null);f.input('mouseUp');assert.deepEqual(await cancelled.choose(),{ok:false,cancelled:true});assert.equal(f.dp.request(f.contents,'media',f.details),false);
 const busy=chooser(f,screen);busy.picker.active=true;f.input('mouseUp');assert.deepEqual(await busy.choose(),{ok:false});assert.equal(busy.picker.opened,0);
});
test('a new chooseScreen drops an earlier unspent pick even if the new one is cancelled',async()=>{
 const f=permissionFixture();f.dp.arm(screen);const c=chooser(f,null);f.input('mouseUp');assert.deepEqual(await c.choose(),{ok:false,cancelled:true});
 assert.equal(f.dp.request(f.contents,'media',f.details),false);
});
test('camera and microphone still need the consent flag and a non-empty audio/video list, and never touch the pick',()=>{
 const f=permissionFixture();const dev=types=>({...f.details,mediaTypes:types});
 assert.equal(f.dp.request(f.contents,'media',dev(['video'])),false);
 f.allow(true);assert.equal(f.dp.request(f.contents,'media',dev(['video'])),true);assert.equal(f.dp.request(f.contents,'media',dev(['audio','video'])),true);
 assert.equal(f.dp.request(f.contents,'media',dev(['video','screen'])),false);
 assert.equal(f.dp.request(f.contents,'geolocation',dev(['video'])),false);assert.equal(f.dp.request(f.contents,'media',{...dev(['video']),isMainFrame:false}),false);
 f.activate(false);assert.equal(f.dp.request(f.contents,'media',dev(['video'])),true,'device gate is the injected predicate');
 f.activate(true);f.dp.arm(screen);assert.equal(f.dp.request(f.contents,'media',dev(['video'])),true);assert.equal(f.timers.length,0,'no watchdog');assert.equal(f.dp.request(f.contents,'media',f.details),true,'pick still unspent');
});
test('permission checks follow consent or a just-granted armed display share, and accept the trailing-slash origin Electron sends',()=>{
 const f=permissionFixture();const checkDetails={isMainFrame:true,requestingUrl:STUDIO_URL,embeddingOrigin:'app://studio/'};
 assert.equal(f.dp.check(f.contents,'media','app://studio/',checkDetails),false);
 f.allow(true);assert.equal(f.dp.check(f.contents,'media','app://studio/',checkDetails),true);assert.equal(f.dp.check(f.contents,'media','app://studio/',{...checkDetails,isMainFrame:false}),false);f.allow(false);
 f.input('mouseUp');assert.equal(f.dp.check(f.contents,'media','app://studio/',checkDetails),false,'input alone opens nothing');
 f.dp.arm(screen);assert.equal(f.dp.check(f.contents,'media','app://studio/',checkDetails),false,'armed but not granted');
 assert.equal(f.dp.request(f.contents,'media',f.details),true);
 assert.equal(f.dp.check(f.contents,'media','app://studio/',checkDetails),true,'within the grant window');
 f.tick(5001);assert.equal(f.dp.check(f.contents,'media','app://studio/',checkDetails),false,'window closed');
 assert.equal(f.dp.check(f.contents,'geolocation','app://studio/',checkDetails),false);
});
// ClaudeBWAI — Codex round 3: once granted, only serve() ends the watch; decide() enforces the instant callback(true) returns.
test('decide(): a grant the handler serves inside callback(true) passes; one it does not serve crashes at once, before any timer',()=>{
 const f=permissionFixture();f.dp.arm(screen);let served=null,answer;
 f.dp.decide(f.contents,'media',granted=>{answer=granted;served=f.dp.serve();},f.details);
 assert.equal(answer,true);assert.equal(served,screen);assert.deepEqual(f.crashed,[]);assert.equal(f.timers[0].live,false,'backstop stopped');
 const g=permissionFixture();g.dp.arm(screen);g.dp.decide(g.contents,'media',granted=>{answer=granted;},g.details);
 assert.equal(answer,true);assert.deepEqual(g.crashed,[g.contents],'crashed synchronously, no timer fired');assert.match(g.logs[0],/\(not served\)/);
 assert.equal(g.timers[0].live,false,'backstop cleared after the crash');g.fire();assert.equal(g.crashed.length,1,'no second crash');
 assert.equal(g.dp.serve(),null,'nothing left to serve');assert.equal(g.dp.outstanding,false);
});
test('decide(): refusals, camera/mic grants and a throwing callback',()=>{
 const f=permissionFixture();let answer;f.dp.decide(f.contents,'media',v=>{answer=v;},f.details);assert.equal(answer,false);assert.deepEqual(f.crashed,[]);
 f.allow(true);f.dp.decide(f.contents,'media',v=>{answer=v;},{...f.details,mediaTypes:['video']});assert.equal(answer,true);assert.deepEqual(f.crashed,[]);
 f.dp.arm(screen);assert.throws(()=>f.dp.decide(f.contents,'media',()=>{throw new Error('Electron threw');},f.details),/Electron threw/);assert.deepEqual(f.crashed,[f.contents],'still enforced');
});
test('a navigation, even one main blocks, does not clear an outstanding grant: it crashes the studio at once',()=>{
 for(const navigate of [c=>c.emit('will-navigate',{preventDefault(){}},'app://studio/blocked.html'),c=>c.emit('did-start-navigation',{},'app://studio/blocked.html',false,true),c=>c.emit('did-start-navigation',{},STUDIO_URL+'#x',true,true)]){
  const f=permissionFixture({enforceOnReturn:false});f.dp.arm(screen);assert.equal(f.dp.request(f.contents,'media',f.details),true);
  navigate(f.contents);assert.deepEqual(f.crashed,[f.contents]);assert.match(f.logs[0],/\(navigation\)/);assert.equal(f.dp.serve(),null);f.fire();assert.equal(f.crashed.length,1);
 }
 const sub=permissionFixture();sub.dp.arm(screen);sub.dp.request(sub.contents,'media',sub.details);sub.contents.emit('did-start-navigation',{},'about:blank',false,false);assert.deepEqual(sub.crashed,[],'subframe navigation is not the document');
});
test('disarm() and a cancelled picker never clear an outstanding grant; the backstop still fires',()=>{
 const f=permissionFixture();f.dp.arm(screen);f.dp.request(f.contents,'media',f.details);f.dp.disarm();assert.equal(f.dp.outstanding,true);
 f.fire();assert.deepEqual(f.crashed,[f.contents]);assert.match(f.logs[0],/\(backstop\)/);
});
test('a second chooseScreen while a grant is outstanding crashes at once, opens no picker, and the backstop cannot crash twice',async()=>{
 for(const result of [screen,null]){const f=permissionFixture();f.dp.arm(screen);f.dp.request(f.contents,'media',f.details);const c=chooser(f,result);f.input('mouseUp');
  assert.deepEqual(await c.choose(),{ok:false});assert.equal(c.picker.opened,0);assert.deepEqual(f.crashed,[f.contents]);assert.match(f.logs[0],/\(new chooseScreen\)/);
  f.fire();assert.equal(f.crashed.length,1);assert.equal(f.dp.request(f.contents,'media',f.details),false,'nothing armed afterwards');}
});
test('a new pick while a grant is outstanding crashes instead of arming',()=>{
 const f=permissionFixture();f.dp.arm(screen);f.dp.request(f.contents,'media',f.details);f.dp.arm({id:'window:2'});
 assert.deepEqual(f.crashed,[f.contents]);assert.match(f.logs[0],/\(new pick\)/);assert.equal(f.dp.request(f.contents,'media',f.details),false);
});
