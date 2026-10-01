// CodexBWAI — no desktop capture; explicit selection and isolated navigation boundary fixtures.
import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {installDisplayPicker,pickerHtml} from '../desktop/display-picker.cjs';
const tick=()=>new Promise(r=>setImmediate(r));
function fixture(t, getSources=async()=>[{id:'screen:1',name:'First',thumbnail:{toDataURL:()=>''}},{id:'window:2',name:'Second',thumbnail:{toDataURL:()=>''}}], options={}) {
 let handler; const session={setDisplayMediaRequestHandler:h=>{handler=h;}};
 const contents=new EventEmitter();contents.mainFrame={url:'app://studio/index.html'};contents.isDestroyed=()=>false;
 const parent=new EventEmitter();parent.webContents=contents;parent.isDestroyed=()=>false;
 const children=[];let enumerations=0;
 class Child extends EventEmitter {
  constructor(options){super();this.options=options;this.dead=false;this.webContents=new EventEmitter();this.webContents.session={setPermissionRequestHandler:h=>{this.permission=h;},setPermissionCheckHandler:h=>{this.check=h;},webRequest:{onBeforeRequest:h=>{this.network=h;}}};this.webContents.setWindowOpenHandler=h=>{this.popup=h;};children.push(this);}
  isDestroyed(){return this.dead;} destroy(){this.dead=true;this.emit('closed');} async loadURL(url){this.url=url;} show(){this.shown=true;}
 }
 const installed=installDisplayPicker({session,getWindow:()=>parent,BrowserWindow:Child,desktopCapturer:{getSources:async opts=>{enumerations++;assert.deepEqual(opts.types,['screen','window']);return getSources();}},...options});t.after(()=>installed.dispose());
 const request={frame:contents.mainFrame,videoRequested:true,audioRequested:false,userGesture:true};
 return {request,children,parent,contents,invoke:(r,cb)=>handler(r,cb),enumerations:()=>enumerations};
}
function pick(child,index){const nonce=child.options.webPreferences.partition.slice('blastcast-picker-'.length);let prevented=false;child.webContents.emit('will-navigate',{preventDefault:()=>{prevented=true;}},`https://blastcast.invalid/${nonce}/pick/${index}`);assert.equal(prevented,true);}
test('requires explicit source selection, blocks network, and returns only selected video',async t=>{
 const f=fixture(t);const answers=[];f.invoke(f.request,r=>answers.push(r));await tick();assert.equal(answers.length,0);const child=f.children[0];assert.ok(child.shown);assert.equal(child.options.webPreferences.sandbox,true);assert.equal(child.options.webPreferences.nodeIntegration,false);
 assert.deepEqual(child.popup(),{action:'deny'});let permission;child.permission(null,null,r=>permission=r);assert.equal(permission,false);
 let result;child.network({url:'https://example.org'},r=>result=r);assert.deepEqual(result,{cancel:true});
 pick(child,1);assert.equal(answers.length,1);assert.equal(answers[0].video.id,'window:2');assert.equal('audio'in answers[0],false);assert.equal(child.dead,true);
});
test('rejects untrusted frame, no gesture, audio capture, and second pending request',async t=>{
 const f=fixture(t);
 for(const override of [{frame:{url:'app://studio/index.html'}},{userGesture:false},{audioRequested:true},{videoRequested:false}]){let answer;f.invoke({...f.request,...override},r=>answer=r);assert.deepEqual(answer,{});}assert.equal(f.enumerations(),0);
 const first=[];f.invoke(f.request,r=>first.push(r));let second;f.invoke(f.request,r=>second=r);assert.deepEqual(second,{});await tick();f.children[0].destroy();assert.deepEqual(first,[{}]);
});
test('activation gate rejects display capture before enumerating sources',async t=>{
 const f=fixture(t,undefined,{authorized:()=>false});let answer;f.invoke(f.request,value=>answer=value);await tick();assert.deepEqual(answer,{});assert.equal(f.enumerations(),0);
});
test('stale main navigation cancels once and late enumeration cannot create a picker',async t=>{
 let resolve;const f=fixture(t,()=>new Promise(r=>resolve=r));const answers=[];f.invoke(f.request,r=>answers.push(r));f.contents.emit('did-start-navigation',{},'app://studio/index.html',false,true);resolve([]);await tick();assert.deepEqual(answers,[{}]);assert.equal(f.children.length,0);
});
test('source names cannot inject markup and invalid selection does not choose first source',async t=>{
 const html=pickerHtml([{name:'<script>evil</script>',thumbnail:{toDataURL:()=> 'https://example.org'}}],'nonce',false);assert.ok(html.includes('&lt;script&gt;'));assert.ok(!html.includes('<script>'));assert.ok(!html.includes('src="https://'));
 const f=fixture(t);const answers=[];f.invoke(f.request,r=>answers.push(r));await tick();pick(f.children[0],'0?extra');assert.equal(answers.length,0);f.contents.mainFrame={url:'app://studio/index.html'};pick(f.children[0],0);assert.deepEqual(answers,[{}]);
});
