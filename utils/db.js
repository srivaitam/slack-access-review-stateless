// Postgres layer for multi-workspace mode. The app runs in one of two modes:
//   - DB mode (DATABASE_URL set): installations, campaigns and the audit chain
//     live in Postgres, keyed by team_id — required for public distribution.
//   - File mode (no DATABASE_URL): original single-workspace behaviour with
//     campaigns/audit on local disk. Used for dev and tests.
const { Pool } = (() => {
  try { return require('pg'); } catch (e) { return { Pool: null }; }
})();

let _pool = null;

function isDbEnabled() {
  return Boolean(process.env.DATABASE_URL);
}

function getPool() {
  if (!isDbEnabled()) throw new Error('DATABASE_URL is not set');
  if (!Pool) throw new Error("The 'pg' package is not installed (npm install pg)");
  if (!_pool) {
    _pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: Number(process.env.PG_POOL_MAX || 10),
      // Render Postgres requires TLS from external hosts; internal URLs work
      // with or without it.
      ssl: process.env.PGSSL === 'disable' ? false : { rejectUnauthorized: false }
    });
    _pool.on('error', err => console.error('[DB] pool error:', err.message));
  }
  return _pool;
}

async function query(text, params) {
  return getPool().query(text, params);
}

// Run fn inside a transaction with a dedicated client.
async function withTx(fn) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

// Idempotent schema bootstrap — safe to run at every boot.
async function ensureSchema() {
  if (!isDbEnabled()) return;
  await query(`
    CREATE TABLE IF NOT EXISTS installations (
      team_id        TEXT PRIMARY KEY,
      team_name      TEXT,
      enterprise_id  TEXT,
      bot_user_id    TEXT,
      bot_token_enc  TEXT NOT NULL,
      scopes         TEXT,
      installed_by   TEXT,
      installed_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS campaigns (
      team_id     TEXT NOT NULL,
      id          TEXT NOT NULL,
      status      TEXT NOT NULL,
      created_at  TIMESTAMPTZ,
      data        JSONB NOT NULL,
      PRIMARY KEY (team_id, id)
    );
    CREATE TABLE IF NOT EXISTS audit_log (
      seq        BIGSERIAL PRIMARY KEY,
      team_id    TEXT NOT NULL,
      id         UUID NOT NULL,
      entry      JSONB NOT NULL,
      prev_hash  TEXT NOT NULL,
      hash       TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS audit_log_team_seq_idx ON audit_log (team_id, seq);
    CREATE TABLE IF NOT EXISTS settings (
      team_id    TEXT PRIMARY KEY,
      data       JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS snapshots (
      id       BIGSERIAL PRIMARY KEY,
      team_id  TEXT NOT NULL,
      taken_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      data     JSONB NOT NULL
    );
    CREATE INDEX IF NOT EXISTS snapshots_team_time_idx ON snapshots (team_id, taken_at DESC);
  `);
  console.log('[DB] schema ready');
}

async function closePool() {
  if (_pool) { await _pool.end(); _pool = null; }
}

module.exports = { isDbEnabled, getPool, query, withTx, ensureSchema, closePool };
