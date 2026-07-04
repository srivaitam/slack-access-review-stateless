const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Configure the audit service BEFORE requiring it (dir + secret are read on load).
process.env.AUDIT_HMAC_SECRET = 'test-secret';
process.env.AUDIT_LOG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-'));

const { logAuditEvent, verifyAuditChain, logFileFor } = require('../services/auditService');

test('audit chain verifies clean and detects tampering (H5)', async () => {
  await logAuditEvent({ action: 'A', actor: { email: 'x@y.z' }, target: { userName: 'u1' }, result: {}, reason: 'r1' });
  await logAuditEvent({ action: 'B', actor: { email: 'x@y.z' }, target: { userName: 'u2' }, result: {}, reason: 'r2' });

  const file = logFileFor();

  const clean = await verifyAuditChain(file);
  assert.equal(clean.ok, true);
  assert.equal(clean.count, 2);

  // Tamper: edit the first entry's reason in place.
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  const first = JSON.parse(lines[0]);
  first.reason = 'TAMPERED';
  lines[0] = JSON.stringify(first);
  fs.writeFileSync(file, lines.join('\n') + '\n');

  const tampered = await verifyAuditChain(file);
  assert.equal(tampered.ok, false, 'tampering must be detected');
});
