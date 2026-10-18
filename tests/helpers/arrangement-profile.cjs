// CodexBWAI — test-owned device fixture; shared scene geometry proves process restart.
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

function prepareArrangementProfile({ directory }) {
  // Synchronous fixture setup keeps shipping main's protocol registration before app ready.
  const settings = path.join(directory, 'studio-preferences');
  fs.mkdirSync(settings, { recursive: true });
  // Both proofs start at 1080p even after the restore proof persisted 2160p.
  // Only devices change; arrangements.json remains the genuine restart witness.
  const preferences = { camera: '', microphone: '', height: 1080 };
  const temporary = path.join(settings, `.proof-devices-${randomUUID()}.tmp`);
  fs.writeFileSync(temporary, JSON.stringify(preferences), { flag: 'wx', mode: 0o600 });
  try { fs.renameSync(temporary, path.join(settings, 'devices.json')); }
  finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
  return preferences;
}

module.exports = { prepareArrangementProfile };
