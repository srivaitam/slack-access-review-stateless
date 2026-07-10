// F-013/F-014: snapshot history — periodically persist a compact summary of the
// access snapshot so we can diff over time (access drift) and chart trends.
// Dual-mode storage; the summarise/diff/trend functions are pure and testable.
const fs = require('fs').promises;
const db = require('../utils/db');
const { getCurrentTeamId } = require('../slack/client');
const { getInternalDomains } = require('./riskScoringService');

const CAPTURE_INTERVAL_MS = Number(process.env.SNAPSHOT_HISTORY_INTERVAL_MS || 12 * 60 * 60 * 1000);
const KEEP = Number(process.env.SNAPSHOT_HISTORY_KEEP || 60);
const FILE = process.env.SNAPSHOT_HISTORY_FILE || './snapshot-history.json';
const _lastCapture = new Map(); // teamId -> ts (throttle)

// Pure: compact the snapshot to counts + per-channel membership (for diffing).
function summarizeSnapshot(snapshot, internalDomains) {
  const isExternal = m => !internalDomains.has((String(m.email || '').split('@')[1] || '').toLowerCase());
  const channels = {};
  const externalIds = new Set();
  const guestIds = new Set();
  for (const { channel, members, riskScore } of snapshot.channels) {
    channels[channel.id] = { name: channel.name, is_private: !!channel.is_private, riskScore: riskScore || 0, members: members.map(m => m.id) };
    for (const m of members) {
      if (isExternal(m)) externalIds.add(m.id);
      if (m.role === 'Guest') guestIds.add(m.id);
    }
  }
  return {
    at: snapshot.metadata.generatedAt,
    totals: {
      users: snapshot.metadata.totalUsers,
      channels: snapshot.metadata.totalChannels,
      external: externalIds.size,
      guests: guestIds.size,
      deactivated: snapshot.users.filter(u => u.active === false).length,
      highRiskChannels: snapshot.channels.filter(c => (c.riskScore || 0) >= 70).length
    },
    channels
  };
}

async function saveSummary(summary, teamId = getCurrentTeamId()) {
  if (db.isDbEnabled()) {
    await db.query('INSERT INTO snapshots (team_id, taken_at, data) VALUES ($1,$2,$3)', [teamId, summary.at, JSON.stringify(summary)]);
    await db.query(
      'DELETE FROM snapshots WHERE team_id=$1 AND id NOT IN (SELECT id FROM snapshots WHERE team_id=$1 ORDER BY taken_at DESC LIMIT $2)',
      [teamId, KEEP]).catch(() => {});
  } else {
    let all = {};
    try { all = JSON.parse(await fs.readFile(FILE, 'utf8')); } catch (e) { /* first write */ }
    all[teamId] = [...(all[teamId] || []), summary].slice(-KEEP);
    await fs.writeFile(FILE, JSON.stringify(all), 'utf8');
  }
}

// Capture at most once per CAPTURE_INTERVAL_MS per team (called after a fresh scan).
async function captureIfDue(snapshot, teamId = getCurrentTeamId()) {
  const last = _lastCapture.get(teamId) || 0;
  if (Date.now() - last < CAPTURE_INTERVAL_MS) return false;
  _lastCapture.set(teamId, Date.now());
  try {
    const internal = getInternalDomains(snapshot.users);
    await saveSummary(summarizeSnapshot(snapshot, internal), teamId);
    return true;
  } catch (e) {
    console.error('[HISTORY] capture failed:', e.message);
    return false;
  }
}

async function getRecentSummaries(limit = 30, teamId = getCurrentTeamId()) {
  if (db.isDbEnabled()) {
    const { rows } = await db.query('SELECT data FROM snapshots WHERE team_id=$1 ORDER BY taken_at DESC LIMIT $2', [teamId, limit]);
    return rows.map(r => r.data); // newest first
  }
  let all = {};
  try { all = JSON.parse(await fs.readFile(FILE, 'utf8')); } catch (e) { /* none */ }
  return (all[teamId] || []).slice(-limit).reverse(); // newest first
}

// Pure: membership + risk changes from prev → curr summary.
function diffSummaries(prev, curr) {
  const joined = [];
  const left = [];
  const pc = prev.channels || {};
  const cc = curr.channels || {};
  for (const id of new Set([...Object.keys(pc), ...Object.keys(cc)])) {
    const before = new Set((pc[id] && pc[id].members) || []);
    const after = new Set((cc[id] && cc[id].members) || []);
    const name = (cc[id] || pc[id]).name;
    after.forEach(u => { if (!before.has(u)) joined.push({ channel: name, user: u }); });
    before.forEach(u => { if (!after.has(u)) left.push({ channel: name, user: u }); });
  }
  const newHighRisk = Object.keys(cc)
    .filter(id => cc[id].riskScore >= 70 && !(pc[id] && pc[id].riskScore >= 70))
    .map(id => cc[id].name);
  return {
    joined,
    left,
    newHighRisk,
    externalDelta: (curr.totals.external || 0) - (prev.totals.external || 0)
  };
}

// Pure: oldest→newest series of totals (input is newest-first).
function trendSeries(summaries) {
  return [...summaries].reverse().map(s => ({ at: s.at, ...s.totals }));
}

module.exports = { summarizeSnapshot, saveSummary, captureIfDue, getRecentSummaries, diffSummaries, trendSeries };
