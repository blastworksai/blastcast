// Authored by CodexBWAI — exercise the production readiness HTTP boundary.
const http = require('node:http');

function confirmReadinessUrl(checkUrl, port, { body = { outsideNetwork: true, secureWithoutBypass: true }, token } = {}) {
  const check = new URL(checkUrl);
  const credential = token ?? check.hash.slice('#check='.length);
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const request = http.request({
      agent: false,
      hostname: '127.0.0.1',
      port,
      method: 'POST',
      path: '/api/readiness/confirm',
      headers: {
        host: check.host,
        origin: check.origin,
        authorization: `Bearer ${credential}`,
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
      },
    }, response => {
      let data = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { data += chunk; });
      response.on('end', () => {
        let parsed = data;
        try { parsed = JSON.parse(data); } catch {}
        resolve({ status: response.statusCode, headers: response.headers, body: parsed });
      });
    });
    request.on('error', reject);
    request.setTimeout(3000, () => request.destroy(new Error('readiness timeout')));
    request.end(payload);
  });
}

function confirmGuestReadiness(guests, options = {}) {
  const status = guests.status();
  if (!options.checkUrl && (status.phase !== 'outside-check' || !status.readiness?.check)) {
    throw new Error('Guest server has no active readiness check.');
  }
  return confirmReadinessUrl(options.checkUrl ?? status.readiness.check.url, status.port, options);
}

async function configureReady(guests, input) {
  const configured = await guests.configure({ routeType: 'direct', ...input });
  if (!configured.ok || configured.phase !== 'outside-check') {
    throw new Error(configured.message ?? `Unexpected readiness phase: ${configured.phase}`);
  }
  const confirmed = await confirmGuestReadiness(guests);
  if (confirmed.status !== 200) throw new Error(`Readiness confirmation failed: ${confirmed.status}`);
  return guests.status();
}

module.exports = { confirmReadinessUrl, confirmGuestReadiness, configureReady };
