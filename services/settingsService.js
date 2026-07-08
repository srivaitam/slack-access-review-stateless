// F-009: per-workspace settings (currently: internal email domains).
// Dual-mode like campaigns/audit:
//   - DB mode (DATABASE_URL): one row per team in the settings table.
//   - File mode: a single JSON file keyed by team id (dev/tests).
// A small in-memory cache lets riskScoringService read the configured domains
// synchronously (getInternalDomains is sync and called per-channel). The cache
// is warmed by generateAccessSnapshot and refreshed on save.
const fs = require('fs').promises;
const db = require('../utils/db');
const { getCurrentTeamId } = require('../slack/client');

const SETTINGS_FILE = process.env.SETTINGS_FILE || './settings.json';
const _cache = new Map(); // teamId -> { internalDomains: string[]|null }

async function _readFile() {
  try { return JSON.parse(await fs.readFile(SETTINGS_FILE, 'utf8')); }
  catch (e) { return {}; }
}

// Load a team's settings from the store into the cache. Returns the settings.
async function loadSettings(teamId = getCurrentTeamId()) {
  let internalDomains = null;
  try {
    if (db.isDbEnabled()) {
      const { rows } = await db.query('SELECT data FROM settings WHERE team_id = $1', [teamId]);
      if (rows.length && rows[0].data) internalDomains = rows[0].data.internalDomains || null;
    } else {
      const all = await _readFile();
      internalDomains = (all[teamId] && all[teamId].internalDomains) || null;
    }
  } catch (e) {
    console.error('[SETTINGS] load failed for', teamId, e.message);
  }
  const value = { internalDomains: Array.isArray(internalDomains) && internalDomains.length ? internalDomains : null };
  _cache.set(teamId, value);
  return value;
}

// Synchronous read of the cached internal domains for the current team.
// Returns an array, or null if none configured / not loaded.
function getCachedInternalDomains(teamId = getCurrentTeamId()) {
  const c = _cache.get(teamId);
  return c ? c.internalDomains : null;
}

async function getInternalDomainsSetting(teamId = getCurrentTeamId()) {
  const s = await loadSettings(teamId);
  return s.internalDomains || [];
}

// Persist internal domains for a team. Empty list clears the override (→ the
// app falls back to the env var, then majority auto-detect).
async function saveInternalDomains(domains, teamId = getCurrentTeamId()) {
  const clean = (domains || []).map(d => String(d).trim().toLowerCase()).filter(Boolean);
  const data = { internalDomains: clean.length ? clean : null };
  if (db.isDbEnabled()) {
    await db.query(
      `INSERT INTO settings (team_id, data) VALUES ($1,$2)
       ON CONFLICT (team_id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
      [teamId, JSON.stringify(data)]);
  } else {
    const all = await _readFile();
    all[teamId] = data;
    await fs.writeFile(SETTINGS_FILE, JSON.stringify(all, null, 2), 'utf8');
  }
  _cache.set(teamId, { internalDomains: data.internalDomains });
  return data.internalDomains || [];
}

module.exports = {
  loadSettings,
  getCachedInternalDomains,
  getInternalDomainsSetting,
  saveInternalDomains
};
