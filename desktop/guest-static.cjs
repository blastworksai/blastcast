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
  ['/guest.css', ['guest.css', 'text/css']],
  ['/Blastworks-Cast-256.png', ['Blastworks-Cast-256.png', 'image/png']],
  ['/source-bitrate.js', ['source-bitrate.js', 'text/javascript']],
  ['/source-protocol.js', ['source-protocol.js', 'text/javascript']],
  ['/source-capture.js', ['source-capture.js', 'text/javascript']],
  ['/source-outbox.js', ['source-outbox.js', 'text/javascript']],
  ['/source-limits.js', ['source-limits.js', 'text/javascript']],
  ['/source-session.js', ['source-session.js', 'text/javascript']],
  ['/source-recovery.js', ['source-recovery.js', 'text/javascript']],
  ['/bodypix/tf.min.js', ['bodypix/tf.min.js', 'text/javascript']],
  ['/bodypix/body-pix.min.js', ['bodypix/body-pix.min.js', 'text/javascript']],
  ['/bodypix/model-stride16.json', ['bodypix/model-stride16.json', 'application/json']],
  ['/bodypix/group1-shard1of1.bin', ['bodypix/group1-shard1of1.bin', 'application/octet-stream']],
  ['/bodypix/NOTICE.txt', ['bodypix/NOTICE.txt', 'text/plain; charset=utf-8']],
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

/** The asset path a GET url maps to ('' when it has a query other than the tfjs model one). */
function guestAssetPath(url) {
  const assetUrl = new URL(url, 'http://guest.invalid');
  const modelQuery = assetUrl.pathname === '/bodypix/model-stride16.json' && assetUrl.search === '?tfjs-format=file';
  return assetUrl.search === '' || modelQuery ? assetUrl.pathname : '';
}

const hasAsset = assetPath => assets.has(assetPath);

async function serveAsset(directory, assetPath, response) {
  const [file, mime] = assets.get(assetPath);
  try { const bytes = await fs.readFile(path.join(directory, file)); send(response, 200, bytes, mime); }
  catch { send(response, 503, { message: 'Guest page unavailable. Ask the host to rebuild BlastCast.' }); }
}

module.exports = { assets, readinessAssets, isReadinessAsset, serveReadinessAsset, guestAssetPath, hasAsset, serveAsset };
