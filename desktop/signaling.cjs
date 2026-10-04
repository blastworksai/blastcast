const MAX_SDP_LENGTH = 65536; // 64KiB
const MAX_CANDIDATE_LENGTH = 2048; // 2KiB
const MAX_QUEUE_LENGTH = 64;
const CALL_ID_RE = /^[A-Za-z0-9_-]{22}$/;

function createSignalingBroker(store) {
  // Map of sessionId -> { callId: string, hostQueue: [], guestQueue: [], hostSeq: number, guestSeq: number }
  // hostQueue: messages FROM host TO guest
  // guestQueue: messages FROM guest TO host
  const sessions = new Map();

  function _validateMessage(msg) {
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return false;
    const keys = Object.keys(msg);
    if (msg.type === 'hangup') {
      return keys.length === 1;
    }
    if (msg.type === 'candidate') {
      if (keys.length !== 2 || !('candidate' in msg)) return false;
      if (msg.candidate === null) return true;
      if (!msg.candidate || typeof msg.candidate !== 'object' || Array.isArray(msg.candidate)) return false;
      
      for (const k of Object.keys(msg.candidate)) {
        if (!['candidate', 'sdpMid', 'sdpMLineIndex', 'usernameFragment'].includes(k)) return false;
      }
      if (typeof msg.candidate.candidate !== 'string') return false;
      if (msg.candidate.sdpMid !== null && typeof msg.candidate.sdpMid !== 'string' && msg.candidate.sdpMid !== undefined) return false;
      if (msg.candidate.sdpMLineIndex !== null && typeof msg.candidate.sdpMLineIndex !== 'number' && msg.candidate.sdpMLineIndex !== undefined) return false;
      if (msg.candidate.sdpMLineIndex != null && (!Number.isInteger(msg.candidate.sdpMLineIndex) || msg.candidate.sdpMLineIndex < 0 || msg.candidate.sdpMLineIndex > 65535)) return false;
      if (msg.candidate.usernameFragment !== null && typeof msg.candidate.usernameFragment !== 'string' && msg.candidate.usernameFragment !== undefined) return false;
      
      const str = JSON.stringify(msg.candidate);
      if (Buffer.byteLength(str, 'utf8') > MAX_CANDIDATE_LENGTH) return false;
      return true;
    }
    if (msg.type === 'screen') return keys.length === 2 && typeof msg.active === 'boolean';
    if (msg.type === 'description') {
      if (!('description' in msg) || keys.some(key => !['type', 'description', 'screenMid', 'iceRestart', 'generation'].includes(key))) return false;
      // ClaudeBWAI — ICE restart: a re-offer on the live call, numbered so the guest's answer can be matched to it.
      if ('iceRestart' in msg && msg.iceRestart !== true) return false;
      if ('generation' in msg && (!Number.isSafeInteger(msg.generation) || msg.generation < 1 || msg.generation > 1000)) return false;
      if ('screenMid' in msg && (typeof msg.screenMid !== 'string' || !/^[A-Za-z0-9_-]{1,32}$/.test(msg.screenMid))) return false;
      if (!msg.description || typeof msg.description !== 'object' || Array.isArray(msg.description)) return false;
      const descKeys = Object.keys(msg.description);
      if (descKeys.length !== 2 || !('type' in msg.description) || !('sdp' in msg.description)) return false;
      if (msg.description.type !== 'offer' && msg.description.type !== 'answer') return false;
      if (typeof msg.description.sdp !== 'string') return false;
      if (Buffer.byteLength(msg.description.sdp, 'utf8') > MAX_SDP_LENGTH) return false;
      return true;
    }
    return false;
  }

  function _getSessionState(sessionId) {
    pruneAll();
    if (!store.isSessionAdmitted(sessionId)) {
      sessions.delete(sessionId);
      return null;
    }
    let state = sessions.get(sessionId);
    if (!state) {
      state = { callId: null, hostQueue: [], guestQueue: [], hostSeq: 0, guestSeq: 0 };
      sessions.set(sessionId, state);
    }
    return state;
  }

  // --- Host IPC Methods ---
  
  function sendGuestSignal(sessionId, callId, message) {
    if (typeof sessionId !== 'string' || typeof callId !== 'string' || !CALL_ID_RE.test(callId)) {
      return { ok: false, message: 'Invalid arguments.' };
    }
    
    if (!_validateMessage(message)) return { ok: false, message: 'Invalid signal message.' };
    if (message.type === 'description' && message.description.type !== 'offer') {
      return { ok: false, message: 'Host must send offer.' };
    }

    const state = _getSessionState(sessionId);
    if (!state) return { ok: false, message: 'Session is not admitted.' };
    
    if (message.type === 'description' && message.description.type === 'offer') {
      // ClaudeBWAI — an ICE-restart offer is the one repeat offer a call accepts; the queues and cursors carry on.
      if (state.callId === callId && message.iceRestart !== true) return { ok: false, message: 'Call already offered. Use a new callId to reconnect.' };
      if (message.iceRestart === true && state.callId !== callId) return { ok: false, message: 'Stale callId.' };
      if (state.callId !== callId) {
        state.callId = callId;
        state.hostQueue = [];
        state.guestQueue = [];
        state.hostSeq = 0;
        state.guestSeq = 0;
      }
    } else {
      if (state.callId !== callId) return { ok: false, message: 'Stale callId.' };
    }
    
    if (state.hostQueue.length >= MAX_QUEUE_LENGTH) return { ok: false, message: 'Signaling queue overflow.' };
    
    state.hostSeq++;
    state.hostQueue.push({ sequence: state.hostSeq, message: structuredClone(message) });
    return { ok: true };
  }

  function pollGuestSignals(sessionId, callId, after) {
    if (typeof sessionId !== 'string' || typeof callId !== 'string' || !CALL_ID_RE.test(callId) || typeof after !== 'number' || !Number.isSafeInteger(after) || after < 0) {
      return { ok: false, message: 'Invalid arguments.' };
    }
    const state = _getSessionState(sessionId);
    if (!state) return { ok: false, message: 'Session is not admitted.' };
    if (state.callId !== callId) return { ok: false, message: 'Stale callId.' };
    if (after > state.guestSeq) return { ok: false, message: 'Future cursor.' };
    
    const oldest = state.guestQueue.length > 0 ? state.guestQueue[0].sequence : (state.guestSeq + 1);
    if (after < oldest - 1) return { ok: false, message: 'Lost cursor.' };

    const messages = [];
    for (const item of state.guestQueue) {
      if (item.sequence > after) messages.push(item);
    }
    
    // Prune consumed items
    state.guestQueue = state.guestQueue.filter(item => item.sequence > after);
    
    return { ok: true, messages: structuredClone(messages), latest: state.guestSeq };
  }

  // --- Guest HTTP Methods ---

  function guestSend(sessionCredential, callId, message) {
    const status = store.guestStatus(sessionCredential);
    if (!status.ok || status.phase !== 'admitted') return { ok: false, message: 'Not admitted.' };
    const sessionId = status.sessionId;
    
    if (typeof callId !== 'string' || !CALL_ID_RE.test(callId)) return { ok: false, message: 'Stale callId.' };
    
    if (!_validateMessage(message)) return { ok: false, message: 'Invalid signal message.' };
    if (message.type === 'description' && message.description.type !== 'answer') {
      return { ok: false, message: 'Guest must send answer.' };
    }

    const state = _getSessionState(sessionId);
    if (!state || state.callId !== callId) return { ok: false, message: 'Stale callId.' };
    
    if (state.guestQueue.length >= MAX_QUEUE_LENGTH) return { ok: false, message: 'Signaling queue overflow.' };
    
    state.guestSeq++;
    state.guestQueue.push({ sequence: state.guestSeq, message: structuredClone(message) });
    return { ok: true };
  }

  function guestPoll(sessionCredential, callId, after) {
    const status = store.guestStatus(sessionCredential);
    if (!status.ok || status.phase !== 'admitted') return { ok: false, message: 'Not admitted.' };
    const sessionId = status.sessionId;
    
    if (callId !== null && (typeof callId !== 'string' || !CALL_ID_RE.test(callId))) return { ok: false, message: 'Stale callId.' };
    if (typeof after !== 'number' || !Number.isSafeInteger(after) || after < 0) return { ok: false, message: 'Invalid arguments.' };
    
    const state = _getSessionState(sessionId);
    if (!state) return { ok: false, message: 'Not admitted.' };
    
    if (state.callId !== callId) {
      // "When a guest polls a different/absent callId it receives the current offer queue from the start."
      return { ok: true, callId: state.callId, messages: structuredClone(state.hostQueue), latest: state.hostSeq };
    }
    
    if (after > state.hostSeq) return { ok: false, message: 'Future cursor.' };

    const oldest = state.hostQueue.length > 0 ? state.hostQueue[0].sequence : (state.hostSeq + 1);
    if (after < oldest - 1) return { ok: false, message: 'Lost cursor.' };

    const messages = [];
    for (const item of state.hostQueue) {
      if (item.sequence > after) messages.push(item);
    }
    
    // Prune consumed items
    state.hostQueue = state.hostQueue.filter(item => item.sequence > after);
    
    return { ok: true, callId: state.callId, messages: structuredClone(messages), latest: state.hostSeq };
  }
  
  function pruneAll() {
    for (const sessionId of Array.from(sessions.keys())) {
      if (!store.isSessionAdmitted(sessionId)) {
        sessions.delete(sessionId);
      }
    }
  }

  return { sendGuestSignal, pollGuestSignals, guestSend, guestPoll, pruneAll };
}

module.exports = { createSignalingBroker };
