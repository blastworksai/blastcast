// CodexBWAI — reserved screen MID prevents camera/share mixing and avoids offer glare.
import test from 'node:test';import assert from 'node:assert/strict';
import { PeerCall } from '../dist/peer-call.js';
class Stream{constructor(tracks=[]){this.tracks=[...tracks];}getTracks(){return this.tracks;}getVideoTracks(){return this.tracks.filter(t=>t.kind==='video');}addTrack(t){this.tracks.push(t);}}
class PC{
 constructor(){this.transceivers=[];this.remoteDescription=null;this.connectionState='new';}
 addTrack(track){this.transceivers.push(this.transceiver(track.kind,track));}
 transceiver(kind,track=null){return {mid:null,direction:'sendrecv',receiver:{track:{kind}},sender:{track,replaceTrack:async function(t){this.track=t;}}};}
 addTransceiver(kind){const t=this.transceiver(kind);this.transceivers.push(t);return t;}
 getTransceivers(){return this.transceivers;}
 async createOffer(){return {type:'offer',sdp:'offer'};}async createAnswer(){return {type:'answer',sdp:'answer'};}
 async setLocalDescription(d){this.localDescription=d;this.transceivers.forEach((t,i)=>t.mid=String(i));this.onicecandidate?.({candidate:{toJSON:()=>({candidate:'ice'})}});}
 async setRemoteDescription(d){this.remoteDescription=d;if(this.transceivers.length===2)this.addTransceiver('video');this.transceivers.forEach((t,i)=>t.mid=String(i));for(const t of this.transceivers)this.ontrack?.({track:t.receiver.track,transceiver:t});}
 async addIceCandidate(){}close(){}async getStats(){return new Map();}
}
globalThis.MediaStream=Stream;globalThis.RTCPeerConnection=PC;
for(const role of ['host','guest'])test(`${role} reserves exact MID and toggles screen without touching camera`,async t=>{
 const camera={kind:'video'},mic={kind:'audio'},screen={kind:'video'},sent=[],remote=[],shares=[];
 const peer=new PeerCall({role,stream:new Stream([camera,mic]),screenShare:true,send:async m=>sent.push(m),onRemoteStream:s=>remote.push(s),onRemoteScreen:s=>shares.push(s),onState:()=>{}});t.after(()=>peer.close());
 await peer.setScreen(new Stream([screen]));await peer.start();
 await peer.receive({type:'description',description:{type:role==='host'?'answer':'offer',sdp:'fixture'},screenMid:'2'});
 await peer.outboundQueue;
 assert.equal(sent[0].type,'description');assert.equal(sent[0].screenMid,'2');
 assert.equal(peer.pc.getTransceivers()[2].sender.track,screen);assert.equal(peer.pc.getTransceivers()[0].sender.track,camera);
 assert.equal(remote.at(-1).getTracks().length,2);assert.ok(shares.every(s=>s===null));
 await peer.receive({type:'screen',active:true});assert.equal(shares.at(-1).getTracks()[0],peer.pc.getTransceivers()[2].receiver.track);
 await peer.receive({type:'screen',active:false});assert.equal(shares.at(-1),null);
 await peer.setScreen(null);await peer.outboundQueue;assert.equal(peer.pc.getTransceivers()[2].sender.track,null);assert.equal(peer.pc.getTransceivers()[0].sender.track,camera);
 assert.deepEqual(sent.at(-1),{type:'screen',active:false});assert.equal(sent.filter(m=>m.type==='description').length,1);
});
