const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');

const AUDIT_LOG_DIR = process.env.AUDIT_LOG_DIR || './audit-logs';
const AUDIT_WEBHOOK_URL = process.env.AUDIT_WEBHOOK_URL || '';
const GENESIS = '0'.repeat(64);

// ── Tamper-evident chain (H5) ──────────────────────────────────────────────
// Each entry carries prev_hash + hash, where
//   hash = HMAC-SHA256(secret, canonical(entry-without-hash))
// The secret lives OUTSIDE the log, so anyone who edits/deletes a row cannot
// recompute a valid chain without it. The chain threads ACROSS monthly files
// (R7), so deleting a whole month's file is also detectable.

function getSecret() {
  const s = process.env.AUDIT_HMAC_SECRET;
  if (s) return s;
  if (process.env.NODE_ENV === 'production') {
    throw new Error('AUDIT_HMAC_SECRET is required in production for tamper-evident audit logging');
  }
  return 'dev-insecure-audit-secret'; // dev only — set a real secret in prod
}

function canonical(entry) {
  return JSON.stringify({
    id: entry.id,
    timestamp: entry.timestamp,
    action: entry.action,
    actor: entry.actor,
    target: entry.target,
    result: entry.result,
    reason: entry.reason,
    metadata: entry.metadata,
    prev_hash: entry.prev_hash
  });
}

function computeHash(entry, secret) {
  return crypto.createHmac('sha256', secret).update(canonical(entry)).digest('hex');
}

function logFileFor(date = new Date()) {
  return path.join(AUDIT_LOG_DIR, `audit-${date.toISOString().slice(0, 7)}.jsonl`);
}

// All monthly chain files, chronological order.
async function listChainFiles() {
  let names;
  try { names = await fs.readdir(AUDIT_LOG_DIR); }
  catch (e) { return []; }
  return names
    .filter(n => /^audit-\d{4}-\d{2}\.jsonl$/.test(n))
    .sort()
    .map(n => path.join(AUDIT_LOG_DIR, n));
}

async function readEntries(file) {
  try {
    const data = await fs.readFile(file, 'utf8');
    return data.trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
  } catch (e) {
    return [];
  }
}

async function readAllEntries() {
  const out = [];
  for (const f of await listChainFiles()) out.push(...await readEntries(f));
  return out;
}

async function lastLineHash(file) {
  const entries = await readEntries(file);
  return entries.length ? (entries[entries.length - 1].hash || null) : null;
}

// Hash the next entry chains from: the last hash of the most recent non-empty
// file (threads across months so a deleted month breaks the chain).
async function readPrevHashForNewEntry() {
  const files = await listChainFiles();
  for (let i = files.length - 1; i >= 0; i--) {
    const h = await lastLineHash(files[i]);
    if (h) return h;
  }
  return GENESIS;
}

// Serialize writes so concurrent audits can't fork the chain.
let writeChain = Promise.resolve();
function enqueue(task) {
  const run = writeChain.then(task, task);
  writeChain = run.then(() => {}, () => {});
  return run;
}

async function logAuditEvent(event) {
  const secret = getSecret();
  const auditId = crypto.randomUUID();

  const entry = await enqueue(async () => {
    await fs.mkdir(AUDIT_LOG_DIR, { recursive: true });
    const prev_hash = await readPrevHashForNewEntry();
    const e = {
      id: auditId,
      timestamp: new Date().toISOString(),
      action: event.action,
      actor: event.actor,
      target: event.target,
      result: event.result,
      reason: event.reason || 'No reason provided',
      metadata: event.metadata || {},
      prev_hash
    };
    e.hash = computeHash(e, secret);
    await fs.appendFile(logFileFor(), JSON.stringify(e) + '\n', 'utf8');
    return e;
  });

  if (AUDIT_WEBHOOK_URL) {
    forwardToSink(entry).catch(err => console.error('[AUDIT] sink forward failed:', err.message));
  }

  console.log('[AUDIT]', entry.action, '|', entry.actor?.email, '→',
    entry.target?.userName, '| hash', entry.hash.slice(0, 12));
  return auditId;
}

async function forwardToSink(entry) {
  const res = await fetch(AUDIT_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(entry)
  });
  if (!res.ok) throw new Error('sink HTTP ' + res.status);
}

// Verify one file's chain starting from `expectedStart` (default GENESIS).
async function verifyAuditChain(logFile, expectedStart = GENESIS) {
  const secret = getSecret();
  const entries = await readEntries(logFile);
  let prev = expectedStart;
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (entry.prev_hash !== prev) {
      return { ok: false, count: entries.length, brokenAt: i, reason: 'prev_hash mismatch' };
    }
    const { hash, ...rest } = entry;
    if (hash !== computeHash(rest, secret)) {
      return { ok: false, count: entries.length, brokenAt: i, reason: 'hash mismatch' };
    }
    prev = hash;
  }
  return { ok: true, count: entries.length, brokenAt: null, lastHash: prev };
}

// Verify the whole directory chronologically, threading hashes across months
// (detects intra-file tampering AND deletion of an entire month's file). R7.
async function verifyAllChains() {
  const files = await listChainFiles();
  let prev = GENESIS;
  let total = 0;
  for (const f of files) {
    const res = await verifyAuditChain(f, prev);
    if (!res.ok) {
      return { ok: false, file: path.basename(f), brokenAt: res.brokenAt, reason: res.reason, files: files.length };
    }
    total += res.count;
    prev = res.lastHash;
  }
  return { ok: true, files: files.length, count: total };
}

// Durable idempotency (R9): has a completed revocation for this key been recorded?
async function hasCompletedRevocation(idempotencyKey) {
  if (!idempotencyKey) return false;
  const entries = await readAllEntries();
  return entries.some(e => e.action === 'ACCESS_REVOKED' && e.metadata && e.metadata.idempotencyKey === idempotencyKey);
}

// Reconciliation (R9): revocations initiated but never completed (e.g. crash
// mid-flight). Returns the initiating records so operators can follow up.
async function findIncompleteRevocations() {
  const entries = await readAllEntries();
  const initiated = new Map();
  const completed = new Set();
  for (const e of entries) {
    const key = e.metadata && e.metadata.idempotencyKey;
    if (!key) continue;
    if (e.action === 'ACCESS_REVOCATION_INITIATED') initiated.set(key, e);
    if (e.action === 'ACCESS_REVOKED') completed.add(key);
  }
  const out = [];
  for (const [key, e] of initiated) {
    if (!completed.has(key)) out.push({ idempotencyKey: key, target: e.target, timestamp: e.timestamp });
  }
  return out;
}

module.exports = {
  logAuditEvent,
  verifyAuditChain,
  verifyAllChains,
  logFileFor,
  readAllEntries,
  hasCompletedRevocation,
  findIncompleteRevocations
};
