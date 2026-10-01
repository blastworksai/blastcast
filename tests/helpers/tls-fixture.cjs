// BWTV — test-only TLS fixture: generates an ephemeral CA + server certificate
// for loopback testing without weakening the shipping TLS verifier.
// The CA and keypair live only in memory and the temp dir for this test run.
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const https = require('node:https');

function createTLSFixture(hostname = 'localhost') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blastcast-tls-'));

  const caKey = path.join(dir, 'ca.key');
  const caCert = path.join(dir, 'ca.crt');
  const serverKey = path.join(dir, 'server.key');
  const serverCsr = path.join(dir, 'server.csr');
  const serverCert = path.join(dir, 'server.crt');
  const extFile = path.join(dir, 'ext.cnf');

  // Generate CA key and self-signed CA certificate (valid 1 day).
  execFileSync('openssl', ['genpkey', '-algorithm', 'EC', '-pkeyopt', 'ec_paramgen_curve:P-256', '-out', caKey]);
  execFileSync('openssl', ['req', '-new', '-x509', '-key', caKey, '-out', caCert,
    '-days', '1', '-subj', '/CN=BlastCast Test CA', '-batch']);

  // SAN extension for the server cert — loopback hostname only.
  fs.writeFileSync(extFile, [
    'subjectAltName=DNS:' + hostname,
    'keyUsage=digitalSignature',
    'extendedKeyUsage=serverAuth',
    'basicConstraints=CA:FALSE',
  ].join('\n'));

  // Generate server key and CSR.
  execFileSync('openssl', ['genpkey', '-algorithm', 'EC', '-pkeyopt', 'ec_paramgen_curve:P-256', '-out', serverKey]);
  execFileSync('openssl', ['req', '-new', '-key', serverKey, '-out', serverCsr,
    '-subj', '/CN=' + hostname, '-batch']);

  // Sign with the CA.
  execFileSync('openssl', ['x509', '-req', '-in', serverCsr, '-CA', caCert, '-CAkey', caKey,
    '-CAcreateserial', '-out', serverCert, '-days', '1', '-extfile', extFile]);

  const ca = fs.readFileSync(caCert, 'utf8');
  const key = fs.readFileSync(serverKey, 'utf8');
  const cert = fs.readFileSync(serverCert, 'utf8');

  return {
    /** PEM CA certificate — pass as `ca` to https.Agent or NODE_EXTRA_CA_CERTS. */
    ca,
    /** PEM server private key — pass to https.createServer. */
    key,
    /** PEM server certificate — pass to https.createServer. */
    cert,
    /** Hostname the certificate covers. */
    hostname,
    /** Temporary directory holding the generated files. */
    dir,

    /** Create an HTTPS server with these credentials. */
    createServer(requestListener) {
      return https.createServer({ key, cert }, requestListener);
    },

    /** Create an https.Agent that trusts only this CA. */
    agent() {
      return new https.Agent({ ca, rejectUnauthorized: true });
    },

    /** Remove temporary files. */
    cleanup() {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    },
  };
}

module.exports = { createTLSFixture };
