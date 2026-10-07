// Static asset map and file serving for the guest server. Split out of guests.cjs (no behaviour change).
const fs = require('node:fs/promises');
const path = require('node:path');
const { send, readinessHeaders } = require('./guest-http.cjs');

const assets = new Map([
  ['/', ['guest.html', 'text/html; charset=utf-8']],
  // ClaudeBWAI — where the guest page moves itself (history.replaceState in guest.ts); a reload there shows the page again.
  ['/guest', ['guest.html', 'text/html; charset=utf-8']],
  ['/guest.js', ['guest.js', 'text/javascript']],
  ['/camera-background.js', ['camera-background.js', 'text/javascript']],
  ['/preview.js', ['preview.js', 'text/javascript']],
  ['/guest-call.js', ['guest-call.js', 'text/javascript']],
  ['/guest-platform.js', ['guest-platform.js', 'text/javascript']],
  ['/guest-invite.js', ['guest-invite.js', 'text/javascript']],
  ['/screen-share.js', ['screen-share.js', 'text/javascript']],
  ['/device-access.js', ['device-access.js', 'text/javascript']],
  ['/peer-call.js', ['peer-call.js', 'text/javascript']],
  ['/chat-ui.js', ['chat-ui.js', 'text/javascript']], // ClaudeBWAI — einh 4-5 Oct: live chat
  ['/guest.css', ['guest.css', 'text/css']],
  ['/Blastworks-Cast-256.png', ['Blastworks-Cast-256.png', 'image/png']],
  ['/source-bitrate.js', ['source-bitrate.js', 'text/javascript']],
  ['/source-protocol.js', ['source-protocol.js', 'text/javascript']],
  ['/source-capture.js', ['source-capture.js', 'text/javascript']],
  ['/source-outbox.js', ['source-outbox.js', 'text/javascript']],
  ['/source-limits.js', ['source-limits.js', 'text/javascript']],
  ['/source-session.js', ['source-session.js', 'text/javascript']],
  ['/source-recovery.js', ['source-recovery.js', 'text/javascript']],
  // ClaudeBWAI — MediaPipe Tasks Vision (7 Oct): same tree under dist/mediapipe as the host protocol serves.
  ['/mediapipe/vision_bundle.mjs', ['mediapipe/vision_bundle.mjs', 'text/javascript']],
  ['/mediapipe/wasm/vision_wasm_internal.js', ['mediapipe/wasm/vision_wasm_internal.js', 'text/javascript']],
  ['/mediapipe/wasm/vision_wasm_nosimd_internal.js', ['mediapipe/wasm/vision_wasm_nosimd_internal.js', 'text/javascript']],
  ['/mediapipe/wasm/vision_wasm_internal.wasm', ['mediapipe/wasm/vision_wasm_internal.wasm', 'application/wasm']],
  ['/mediapipe/wasm/vision_wasm_nosimd_internal.wasm', ['mediapipe/wasm/vision_wasm_nosimd_internal.wasm', 'application/wasm']],
  ['/mediapipe/selfie_segmenter.tflite', ['mediapipe/selfie_segmenter.tflite', 'application/octet-stream']],
  ['/mediapipe/NOTICE.txt', ['mediapipe/NOTICE.txt', 'text/plain; charset=utf-8']],
]);
const readinessAssets = new Map([
  ['/readiness', ['readiness.html', 'text/html; charset=utf-8']],
  ['/readiness.js', ['readiness.js', 'text/javascript']],
  ['/readiness.css', ['readiness.css', 'text/css']],
]);

const isReadinessAsset = url => readinessAssets.has(url);

async function serveReadinessAsset(directory, url, response) {
  const [file, mime] = readinessAssets.get(url);
  try { const bytes = await fs.readFile(path.join(directory, file)); send(response, 200, bytes, mime, readinessHeaders); }
  catch { send(response, 503, { message: 'Readiness page unavailable. Ask the host to rebuild BlastCast.' }, 'application/json', readinessHeaders); }
}

/** The asset path a GET url maps to ('' when it has any query string). */
function guestAssetPath(url) {
  const assetUrl = new URL(url, 'http://guest.invalid');
  return assetUrl.search === '' ? assetUrl.pathname : '';
}

const hasAsset = assetPath => assets.has(assetPath);

async function serveAsset(directory, assetPath, response) {
  const [file, mime] = assets.get(assetPath);
  try { const bytes = await fs.readFile(path.join(directory, file)); send(response, 200, bytes, mime); }
  catch { send(response, 503, { message: 'Guest page unavailable. Ask the host to rebuild BlastCast.' }); }
}

module.exports = { assets, readinessAssets, isReadinessAsset, serveReadinessAsset, guestAssetPath, hasAsset, serveAsset };
