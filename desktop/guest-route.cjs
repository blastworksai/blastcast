// Route parsing and the host's own outside-route probe. Split out of guests.cjs (no behaviour change).
const https = require('node:https');
const { parseHelper } = require('./relay-config.cjs');

function parseRoute(input) {
  if (!input || typeof input !== 'object' || !['origin,port,routeType', 'helper,origin,port,routeType'].includes(Object.keys(input).sort().join()) ||
      typeof input.origin !== 'string' || input.origin.length > 300 ||
      !Number.isInteger(input.port) || input.port < 1024 || input.port > 65535) throw new Error('Enter an HTTPS address and a local port from 1024 to 65535.');
  if (input.routeType !== 'direct' && input.routeType !== 'tunnel') throw new Error('Choose direct forwarding or an HTTPS tunnel/provider as the route type.');
  let url;
  try { url = new URL(input.origin); } catch { throw new Error('Enter a valid HTTPS address.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/')
    throw new Error('Use an HTTPS address without a path, password, query or fragment.');
  const helper = parseHelper(input.helper);
  if (helper && input.routeType !== 'tunnel') throw new Error('A helper requires the HTTPS tunnel route.');
  return { origin: url.origin, host: url.host, port: input.port, routeType: input.routeType, ...(helper ? { helper } : {}) };
}

function routeError(code, message) { const error = new Error(message); error.code = code; return error; }

function createRouteVerifier({ ca } = {}) {
  return function verifyRoute(origin, nonce, proof, signal) {
    return new Promise((resolve, reject) => {
      let timer;
      const options = { signal, agent: false, ...(ca === undefined ? {} : { ca }) };
      const request = https.get(`${origin}/route-check/${nonce}`, options, response => {
        let body = '';
        if (response.statusCode !== 200) { response.resume(); request.destroy(routeError('HOST_ROUTE_MISMATCH', 'Guest address did not return the route check.')); return; }
        response.setEncoding('utf8');
        response.on('data', chunk => {
          body += chunk;
          if (body.length > 256) request.destroy(routeError('HOST_ROUTE_MISMATCH', 'Unexpected route-check response.'));
        });
        response.on('error', reject);
        response.on('end', () => body === proof ? resolve() : reject(routeError('HOST_ROUTE_MISMATCH', 'Guest address points somewhere else.')));
      });
      request.on('error', reject);
      request.on('close', () => clearTimeout(timer));
      timer = setTimeout(() => request.destroy(routeError('HOST_ROUTE_UNREACHABLE', 'Guest address did not answer in time.')), 5000);
    });
  };
}
const verifyRoute = createRouteVerifier();

module.exports = { parseRoute, createRouteVerifier, verifyRoute };
