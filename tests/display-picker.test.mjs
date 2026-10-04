// CodexBWAI — no desktop capture; explicit selection and isolated navigation boundary fixtures.
import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {installDisplayPicker,pickerHtml,pickerUrl} from '../desktop/display-picker.cjs';
const tick=()=>new Promise(r=>setImmediate(r));
let failLoad=false;
function fixture(t, getSources=async()=>[{id:'screen:1',name:'First',thumbnail:{toDataURL:()=>''}},{id:'window:2',name:'Second',thumbnail:{toDataURL:()=>''}}], options={}) {
 let handler; const session={setDisplayMediaRequestHandler:h=>{handler=h;}};
 const contents=new EventEmitter();contents.mainFrame={url:'app://studio/index.html'};contents.isDestroyed=()=>false;
 const parent=new EventEmitter();parent.webContents=contents;parent.isDestroyed=()=>false;
 const children=[];let enumerations=0;
 class Child extends EventEmitter {
  constructor(options){super();this.options=options;this.dead=false;this.webContents=new EventEmitter();this.webContents.session={setPermissionRequestHandler:h=>{this.permission=h;},setPermissionCheckHandler:h=>{this.check=h;},webRequest:{onBeforeRequest:h=>{this.network=h;}},protocol:{handle:(scheme,h)=>{this.scheme=scheme;this.serve=h;}}};this.webContents.setWindowOpenHandler=h=>{this.popup=h;};children.push(this);}
  isDestroyed(){return this.dead;} destroy(){this.dead=true;this.emit('closed');} async loadURL(url){this.url=url;if(failLoad)throw new Error('ERR_INVALID_URL');} show(){this.shown=true;}
 }
 const installed=installDisplayPicker({session,getWindow:()=>parent,BrowserWindow:Child,desktopCapturer:{getSources:async opts=>{enumerations++;assert.deepEqual(opts.types,['screen','window']);return getSources();}},...options});t.after(()=>installed.dispose());
 const request={frame:contents.mainFrame,videoRequested:true,audioRequested:false,userGesture:true};
 return {installed,request,children,parent,contents,choose:()=>installed.choose(),invoke:(r,cb)=>handler(r,cb),enumerations:()=>enumerations};
}
function pick(child,index){const nonce=child.options.webPreferences.partition.slice('blastcast-picker-'.length);let prevented=false;child.webContents.emit('will-navigate',{preventDefault:()=>{prevented=true;}},`https://blastcast.invalid/${nonce}/pick/${index}`);assert.equal(prevented,true);}
// ClaudeBWAI — the picker now opens from chooseScreen (installed.choose()), before getDisplayMedia; the display-media
// handler only serves the armed pick (serve()). Every hardening assertion of the earlier handler-driven picker is kept.
test('requires explicit source selection, blocks network, and returns only the selected source',async t=>{
 const f=fixture(t);const chosen=f.choose();await tick();const child=f.children[0];assert.ok(child.shown);assert.equal(child.options.webPreferences.sandbox,true);assert.equal(child.options.webPreferences.nodeIntegration,false);
 assert.deepEqual(child.popup(),{action:'deny'});let permission;child.permission(null,null,r=>permission=r);assert.equal(permission,false);
 let result;child.network({url:'https://example.org'},r=>result=r);assert.deepEqual(result,{cancel:true});
 pick(child,1);assert.equal((await chosen).id,'window:2');assert.equal(child.dead,true);assert.equal(f.installed.active,false);
});
test('the display-media handler serves only what serve() hands it, only to the trusted studio request, and opens no picker',async t=>{
 const source={id:'window:2'};let calls=0;const f=fixture(t,undefined,{serve:()=>{calls++;return source;}});
 for(const override of [{frame:{url:'app://studio/index.html'}},{audioRequested:true},{videoRequested:false}]){let answer;f.invoke({...f.request,...override},r=>answer=r);assert.deepEqual(answer,{});}
 assert.equal(calls,3,'an untrusted request still consumes the grant (reaching the handler proves it was not the legacy path), so its refusal is not a breach; it gets nothing (Codex round 4)');
 let answer;f.invoke({...f.request,userGesture:false},r=>answer=r);assert.deepEqual(answer,{video:source},'activation lapses while the host is in the picker');
 assert.equal(f.children.length,0);assert.equal(f.enumerations(),0);
 const empty=fixture(t);empty.invoke(empty.request,r=>answer=r);assert.deepEqual(answer,{},'nothing armed, nothing served');
});
test('a second pick while one is open is refused, and dispose cancels the open one',async t=>{
 const f=fixture(t);const first=f.choose();assert.equal(f.installed.active,true);assert.equal(await f.choose(),null);await tick();assert.equal(f.children.length,1);
 f.children[0].destroy();assert.equal(await first,null);
 const again=f.choose();await tick();f.installed.dispose();assert.equal(await again,null);assert.equal(f.children[1].dead,true);
});
test('activation gate refuses the picker before enumerating sources',async t=>{
 const f=fixture(t,undefined,{authorized:()=>false,serve:()=>({id:'screen:1'})});assert.equal(await f.choose(),null);assert.equal(f.enumerations(),0);
 let answer;f.invoke(f.request,value=>answer=value);assert.deepEqual(answer,{});
});
test('stale main navigation cancels once and late enumeration cannot create a picker',async t=>{
 let resolve;const f=fixture(t,()=>new Promise(r=>resolve=r));const chosen=f.choose();f.contents.emit('did-start-navigation',{},'app://studio/index.html',false,true);resolve([]);await tick();assert.equal(await chosen,null);assert.equal(f.children.length,0);
});
test('source names cannot inject markup and invalid selection does not choose first source',async t=>{
 const html=pickerHtml([{name:'<script>evil</script>',thumbnail:{toDataURL:()=> 'https://example.org'}}],'nonce',false);assert.ok(html.includes('&lt;script&gt;'));assert.ok(!html.includes('<script>'));assert.ok(!html.includes('src="https://'));
 const f=fixture(t);const chosen=f.choose();await tick();pick(f.children[0],'0?extra');assert.equal(f.installed.active,true);f.contents.mainFrame={url:'app://studio/other.html'};pick(f.children[0],0);assert.equal(await chosen,null);
});

// ClaudeBWAI — picker page is served by the picker session's protocol handler, never a data: URL.
test('picker page loads from its own https URL, served only for that URL, and stays under the URL limit with 40 big thumbnails',async t=>{
 const big={toDataURL:()=>'data:image/png;base64,'+'A'.repeat(95000)};
 const f=fixture(t,async()=>Array.from({length:40},(_,i)=>({id:'window:'+i,name:'W'+i,thumbnail:big})));
 const chosen=f.choose();await tick();const child=f.children[0];
 const nonce=child.options.webPreferences.partition.slice('blastcast-picker-'.length);const url=pickerUrl(nonce);
 assert.equal(child.url,url);assert.equal(url,`https://blastcast.invalid/${nonce}/index.html`);assert.ok(child.url.length<200);assert.ok(!child.url.startsWith('data:'));
 assert.equal(child.scheme,'https');assert.ok(child.shown);
 const page=await child.serve({url,method:'GET'});assert.equal(page.status,200);const body=await page.text();assert.ok(body.length>3_000_000);assert.equal((body.match(/pick\/\d+/g)||[]).length,40);
 assert.match(page.headers.get('content-security-policy'),/default-src 'none'/);assert.match(page.headers.get('content-security-policy'),/frame-src 'none'/);
 assert.equal((await child.serve({url:url+'?x=1',method:'GET'})).status,404);assert.equal((await child.serve({url:`https://blastcast.invalid/other/index.html`,method:'GET'})).status,404);assert.equal((await child.serve({url,method:'POST'})).status,404);
 let r;child.network({url},v=>r=v);assert.deepEqual(r,{cancel:false});child.network({url:'data:image/png;base64,AAAA'},v=>r=v);assert.deepEqual(r,{cancel:false});
 child.network({url:'data:text/html,hi'},v=>r=v);assert.deepEqual(r,{cancel:true});child.network({url:`https://blastcast.invalid/${nonce}/pick/1`},v=>r=v);assert.deepEqual(r,{cancel:true});
 pick(child,39);assert.equal((await chosen).id,'window:39');
});
test('a failed picker load cancels the pick, closes the window and says why',async t=>{
 const f=fixture(t);const errors=[];const original=console.error;console.error=(...a)=>errors.push(a.join(' '));failLoad=true;t.after(()=>{console.error=original;failLoad=false;});
 const chosen=f.choose();await tick();await tick();
 assert.equal(await chosen,null);assert.equal(f.children[0].dead,true);assert.equal(f.children[0].shown,undefined);assert.ok(errors.some(e=>e.includes('ERR_INVALID_URL')));
});
test('a picker timeout cancels the pick',async t=>{
 const f=fixture(t,undefined,{timeoutMs:1000});t.mock.timers.enable({apis:['setTimeout']});const chosen=f.choose();t.mock.timers.tick(1000);assert.equal(await chosen,null);
});
