// F-009: per-workspace settings.
//   - internalDomains: which email domains are treated as internal (risk/audit)
//   - hiddenTabs:      dashboard toolbar buttons the admin has chosen to hide
// Dual-mode like campaigns/audit:
//   - DB mode (DATABASE_URL): one row per team in the settings table (JSON blob).
//   - File mode: a single JSON file keyed by team id (dev/tests).
// A small in-memory cache lets riskScoringService read the configured domains
// synchronously (getCachedInternalDomains is sync and called per-channel). The
// cache is warmed by loadSettings and refreshed on every save. Saves are
// read-modify-write so the two setting groups never clobber each other.
const fs = require('fs').promises;
const db = require('../utils/db');
const { getCurrentTeamId } = require('../slack/client');

const SETTINGS_FILE = process.env.SETTINGS_FILE || './settings.json';
const _cache = new Map(); // teamId -> { internalDomains: string[]|null, hiddenTabs: string[] }

async function _readFile() {
  try { return JSON.parse(await fs.readFile(SETTINGS_FILE, 'utf8')); }
  catch (e) { return {}; }
}

// Read a team's full raw settings blob from the store (DB row or file).
async function _readTeamData(teamId) {
  try {
    if (db.isDbEnabled()) {
      const { rows } = await db.query('SELECT data FROM settings WHERE team_id = $1', [teamId]);
      return (rows.length && rows[0].data) ? rows[0].data : {};
    }
    const all = await _readFile();
    return all[teamId] || {};
  } catch (e) {
    console.error('[SETTINGS] read failed for', teamId, e.message);
    return {};
  }
}

// Write a team's full raw settings blob back to the store.
async function _writeTeamData(teamId, data) {
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
}

// Coerce a raw blob into the normalized shape kept in the cache / returned.
function _normalize(data) {
  const internalDomains = Array.isArray(data.internalDomains) && data.internalDomains.length ? data.internalDomains : null;
  const hiddenTabs = Array.isArray(data.hiddenTabs) ? data.hiddenTabs.map(String) : [];
  return { internalDomains, hiddenTabs };
}

// Load a team's settings from the store into the cache. Returns the settings.
async function loadSettings(teamId = getCurrentTeamId()) {
  const value = _normalize(await _readTeamData(teamId));
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
// app falls back to the env var, then majority auto-detect). Other settings
// (e.g. hiddenTabs) are preserved.
async function saveInternalDomains(domains, teamId = getCurrentTeamId()) {
  const clean = (domains || []).map(d => String(d).trim().toLowerCase()).filter(Boolean);
  const existing = await _readTeamData(teamId);
  const data = { ...existing, internalDomains: clean.length ? clean : null };
  await _writeTeamData(teamId, data);
  const value = _normalize(data);
  _cache.set(teamId, value);
  return value.internalDomains || [];
}

// Which dashboard toolbar tabs this team has chosen to hide (array of tab keys).
async function getHiddenTabsSetting(teamId = getCurrentTeamId()) {
  const s = await loadSettings(teamId);
  return s.hiddenTabs || [];
}

// Persist the hidden-tabs list for a team. Empty list → every tab is shown.
// Other settings (e.g. internalDomains) are preserved.
async function saveHiddenTabs(tabs, teamId = getCurrentTeamId()) {
  const clean = [...new Set((tabs || []).map(t => String(t).trim()).filter(Boolean))];
  const existing = await _readTeamData(teamId);
  const data = { ...existing, hiddenTabs: clean };
  await _writeTeamData(teamId, data);
  _cache.set(teamId, _normalize(data));
  return clean;
}

module.exports = {
  loadSettings,
  getCachedInternalDomains,
  getInternalDomainsSetting,
  saveInternalDomains,
  getHiddenTabsSetting,
  saveHiddenTabs
};
