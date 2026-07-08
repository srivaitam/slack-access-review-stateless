const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const db = require('../utils/db');
const { getCurrentTeamId } = require('../slack/client');

const AUDIT_LOG_DIR = process.env.AUDIT_LOG_DIR || './audit-logs';
const AUDIT_WEBHOOK_URL = process.env.AUDIT_WEBHOOK_URL || '';
const GENESIS = '0'.repeat(64);

// ── Tamper-evident chain (H5) ──────────────────────────────────────────────
// Each entry carries prev_hash + hash, where
//   hash = HMAC-SHA256(secret, canonical(entry-without-hash))
// The secret lives OUTSIDE the store, so anyone who edits/deletes a row cannot
// recompute a valid chain without it.
//
// Storage is dual-mode:
//   - DB mode (DATABASE_URL): one chain per team_id in the audit_log table.
//     Appends take a per-team advisory lock inside a transaction so the chain
//     cannot fork even with multiple instances.
//   - File mode: original monthly JSONL files (single-workspace dev/tests).

function getSecret() {
  const s = process.env.AUDIT_HMAC_SECRET;
  if (s) return s;
  if (process.env.NODE_ENV === 'production') {
    throw new Error('AUDIT_HMAC_SECRET is required in production for tamper-evident audit logging');
  }
  return 'dev-insecure-audit-secret'; // dev only — set a real secret in prod
}

// Deterministic serialization: recursively sorts object keys so the output is
// independent of key ordering. This is REQUIRED because entries are stored in a
// Postgres JSONB column, and JSONB reorders object keys on write. Hashing the
// re-read object with a naive JSON.stringify produced false "hash mismatch"
// chain breaks (H5b) even with no tampering. Sorting keys makes write-time and
// read-time serialization identical regardless of how storage ordered them.
// Matches JSON.stringify semantics for undefined (omit in objects, null in arrays).
function stableStringify(value) {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return '[' + value.map(v => { const s = stableStringify(v); return s === undefined ? 'null' : s; }).join(',') + ']';
  }
  const parts = [];
  for (const k of Object.keys(value).sort()) {
    const s = stableStringify(value[k]);
    if (s !== undefined) parts.push(JSON.stringify(k) + ':' + s);
  }
  return '{' + parts.join(',') + '}';
}

function canonical(entry) {
  return stableStringify({
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

function buildEntry(event, prev_hash, secret) {
  const e = {
    id: crypto.randomUUID(),
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
  return e;
}

// Walk a list of entries and verify the chain from expectedStart.
function verifyEntries(entries, secret, expectedStart = GENESIS) {
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

// ── File-mode helpers (unchanged behaviour) ────────────────────────────────

function logFileFor(date = new Date()) {
  return path.join(AUDIT_LOG_DIR, `audit-${date.toISOString().slice(0, 7)}.jsonl`);
}

async function listChainFiles() {
  let names;
  try { names = await fs.readdir(AUDIT_LOG_DIR); }
  catch (e) { return []; }
  return names
    .filter(n => /^audit-\d{4}-\d{2}\.jsonl$/.test(n))
    .sort()
    .map(n => path.join(AUDIT_LOG_DIR, n));
}

async function readEntriesFile(file) {
  try {
    const data = await fs.readFile(file, 'utf8');
    return data.trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
  } catch (e) {
    return [];
  }
}

async function lastLineHash(file) {
  const entries = await readEntriesFile(file);
  return entries.length ? (entries[entries.length - 1].hash || null) : null;
}

async function readPrevHashForNewEntry() {
  const files = await listChainFiles();
  for (let i = files.length - 1; i >= 0; i--) {
    const h = await lastLineHash(files[i]);
    if (h) return h;
  }
  return GENESIS;
}

// Serialize writes so concurrent audits can't fork the chain (file mode).
let writeChain = Promise.resolve();
function enqueue(task) {
  const run = writeChain.then(task, task);
  writeChain = run.then(() => {}, () => {});
  return run;
}

// ── DB-mode helpers ────────────────────────────────────────────────────────

// Stable 32-bit lock key per team for pg_advisory_xact_lock.
function teamLockKey(teamId) {
  return crypto.createHash('sha256').update('audit:' + teamId).digest().readInt32BE(0);
}

async function readAllEntriesDb(teamId) {
  const { rows } = await db.query(
    'SELECT entry FROM audit_log WHERE team_id = $1 ORDER BY seq', [teamId]);
  return rows.map(r => r.entry);
}

// ── Public API ─────────────────────────────────────────────────────────────

async function readAllEntries(teamId = getCurrentTeamId()) {
  if (db.isDbEnabled()) return readAllEntriesDb(teamId);
  return (async () => {
    const out = [];
    for (const f of await listChainFiles()) out.push(...await readEntriesFile(f));
    return out;
  })();
}

async function logAuditEvent(event) {
  const secret = getSecret();
  let entry;

  if (db.isDbEnabled()) {
    const teamId = getCurrentTeamId();
    entry = await db.withTx(async client => {
      await client.query('SELECT pg_advisory_xact_lock($1)', [teamLockKey(teamId)]);
      const { rows } = await client.query(
        'SELECT hash FROM audit_log WHERE team_id = $1 ORDER BY seq DESC LIMIT 1', [teamId]);
      const prev_hash = rows.length ? rows[0].hash : GENESIS;
      const e = buildEntry(event, prev_hash, secret);
      await client.query(
        'INSERT INTO audit_log (team_id, id, entry, prev_hash, hash) VALUES ($1,$2,$3,$4,$5)',
        [teamId, e.id, JSON.stringify(e), e.prev_hash, e.hash]);
      return e;
    });
  } else {
    entry = await enqueue(async () => {
      await fs.mkdir(AUDIT_LOG_DIR, { recursive: true });
      const prev_hash = await readPrevHashForNewEntry();
      const e = buildEntry(event, prev_hash, secret);
      await fs.appendFile(logFileFor(), JSON.stringify(e) + '\n', 'utf8');
      return e;
    });
  }

  if (AUDIT_WEBHOOK_URL) {
    forwardToSink(entry).catch(err => console.error('[AUDIT] sink forward failed:', err.message));
  }

  console.log('[AUDIT]', entry.action, '|', entry.actor?.email, '→',
    entry.target?.userName, '| hash', entry.hash.slice(0, 12));
  return entry.id;
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
  return verifyEntries(await readEntriesFile(logFile), getSecret(), expectedStart);
}

// Verify the whole chain for the current team (DB mode) or the whole
// directory chronologically, threading hashes across months (file mode). R7.
async function verifyAllChains(teamId = getCurrentTeamId()) {
  const secret = getSecret();
  if (db.isDbEnabled()) {
    const res = verifyEntries(await readAllEntriesDb(teamId), secret);
    if (!res.ok) return { ok: false, file: 'db:' + teamId, brokenAt: res.brokenAt, reason: res.reason, files: 1 };
    return { ok: true, files: 1, count: res.count };
  }
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
  if (db.isDbEnabled()) {
    const { rows } = await db.query(
      `SELECT 1 FROM audit_log
       WHERE team_id = $1 AND entry->>'action' = 'ACCESS_REVOKED'
         AND entry->'metadata'->>'idempotencyKey' = $2 LIMIT 1`,
      [getCurrentTeamId(), idempotencyKey]);
    return rows.length > 0;
  }
  const entries = await readAllEntries();
  return entries.some(e => e.action === 'ACCESS_REVOKED' && e.metadata && e.metadata.idempotencyKey === idempotencyKey);
}

// Reconciliation (R9): revocations initiated but never completed (e.g. crash
// mid-flight). Returns the initiating records so operators can follow up.
async function findIncompleteRevocations(teamId = getCurrentTeamId()) {
  const entries = await readAllEntries(teamId);
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

// ── Re-seal (H5b remediation) ───────────────────────────────────────────────
// One-time fix for chains written before canonicalization was made JSONB-safe.
// Recomputes prev_hash + hash for every entry, in seq order, over the CURRENT
// stored content using the deterministic canonical form. It does NOT alter the
// audited facts (actor/action/target/result/reason/metadata are untouched) —
// it only rewrites the integrity seals so the chain verifies again. Runs under
// the per-team advisory lock so it can't race with live appends.
async function resealChain(teamId) {
  if (!db.isDbEnabled()) throw new Error('resealChain is DB-mode only');
  const secret = getSecret();
  return db.withTx(async client => {
    await client.query('SELECT pg_advisory_xact_lock($1)', [teamLockKey(teamId)]);
    const { rows } = await client.query(
      'SELECT seq, entry FROM audit_log WHERE team_id = $1 ORDER BY seq', [teamId]);
    let prev = GENESIS;
    let updated = 0;
    for (const row of rows) {
      const e = row.entry;
      e.prev_hash = prev;
      const { hash, ...rest } = e; // eslint-disable-line no-unused-vars
      const newHash = computeHash(rest, secret);
      e.hash = newHash;
      await client.query(
        'UPDATE audit_log SET entry = $1, prev_hash = $2, hash = $3 WHERE team_id = $4 AND seq = $5',
        [JSON.stringify(e), prev, newHash, teamId, row.seq]);
      prev = newHash;
      updated++;
    }
    return { teamId, updated, lastHash: prev };
  });
}

async function resealAllChains() {
  if (!db.isDbEnabled()) throw new Error('resealAllChains is DB-mode only');
  const { rows } = await db.query('SELECT DISTINCT team_id FROM audit_log');
  const out = [];
  for (const r of rows) out.push(await resealChain(r.team_id));
  return out;
}

module.exports = {
  logAuditEvent,
  verifyAuditChain,
  verifyAllChains,
  verifyEntries,
  canonical,
  computeHash,
  logFileFor,
  readAllEntries,
  hasCompletedRevocation,
  findIncompleteRevocations,
  resealChain,
  resealAllChains
};
