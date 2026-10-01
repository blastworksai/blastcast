// CodexBWAI — hostile activation text crosses one verification door here.
const { createPublicKey, verify } = require('node:crypto');

const KEY_RE = /^BCAST1\.([A-Za-z0-9_-]{1,2048})\.([A-Za-z0-9_-]{86})$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function exact(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
function verifyLicenseKey(raw, publicKey) {
  if (typeof raw !== 'string' || raw.length > 4096) return null;
  const match = KEY_RE.exec(raw.trim());
  if (!match) return null;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(match[1], 'base64url').toString('utf8'));
    if (!verify(null, Buffer.from(match[1], 'ascii'), createPublicKey(publicKey), Buffer.from(match[2], 'base64url'))) return null;
  } catch { return null; }
  const keys = ['v', 'product', 'licenseId', 'holder', 'kind', 'issuedAt'];
  if (!exact(payload, keys) || payload.v !== 1 || payload.product !== 'blastcast' || !UUID_RE.test(payload.licenseId)
      || typeof payload.holder !== 'string' || !payload.holder || payload.holder.length > 120 || /[\u0000-\u001f\u007f]/u.test(payload.holder)
      || !['owner', 'test', 'customer'].includes(payload.kind) || typeof payload.issuedAt !== 'string'
      || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(payload.issuedAt) || !Number.isFinite(Date.parse(payload.issuedAt))) return null;
  return Object.freeze({ licenseId: payload.licenseId, holder: payload.holder, kind: payload.kind, issuedAt: payload.issuedAt });
}

module.exports = { verifyLicenseKey };
