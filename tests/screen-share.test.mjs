// CodexBWAI — display capture is separately owned and never retains accidental audio.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ScreenShare } from '../dist/screen-share.js';
class Track extends EventTarget { constructor(kind){super();this.kind=kind;this.readyState='live';} stop(){this.readyState='ended';} }
class Stream { constructor(tracks){this.tracks=tracks;}getTracks(){return this.tracks;}getVideoTracks(){return this.tracks.filter(t=>t.kind==='video');}getAudioTracks(){return this.tracks.filter(t=>t.kind==='audio');}removeTrack(track){this.tracks=this.tracks.filter(t=>t!==track);} }
test('display capture strips audio, stops owned screen on browser end, leaves camera alone',async()=>{
 const screen=new Track('video'),audio=new Track('audio'),camera=new Track('video'),stream=new Stream([screen,audio]);const changes=[];
 const share=new ScreenShare(async()=>stream,(s,m)=>changes.push([s,m]));await share.start();
 assert.equal(share.stream,stream);assert.equal(audio.readyState,'ended');assert.deepEqual(stream.getTracks(),[screen]);
 screen.dispatchEvent(new Event('ended'));assert.equal(share.stream,null);assert.equal(screen.readyState,'ended');assert.equal(camera.readyState,'live');assert.equal(changes.at(-1)[0],null);
});
test('stop during picker prevents late display from becoming live',async()=>{
 let resolve;const screen=new Track('video');const changes=[];const share=new ScreenShare(()=>new Promise(r=>resolve=r),s=>changes.push(s));
 const pending=share.start();share.stop();resolve(new Stream([screen]));await pending;
 assert.equal(screen.readyState,'ended');assert.equal(share.stream,null);assert.ok(changes.every(s=>s===null));
});
test('denied display picker remains retryable',async()=>{
 let tries=0;const share=new ScreenShare(async()=>{if(++tries===1)throw Error('denied');return new Stream([new Track('video')]);},()=>{});
 await share.start();assert.equal(share.busy,false);await share.start();assert.ok(share.stream);share.stop();
});
