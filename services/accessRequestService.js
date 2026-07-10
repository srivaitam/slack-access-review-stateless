// F-018: access request + approval flow. A member requests access to a channel;
// the request is routed to the channel owner (creator) for approve/deny.
// Dual-mode storage keyed by (team_id, id).
const crypto = require('crypto');
const fs = require('fs').promises;
const db = require('../utils/db');
const { getCurrentTeamId } = require('../slack/client');

const FILE = process.env.ACCESS_REQUESTS_FILE || './access-requests.json';

function newId() {
  return 'ar' + Date.now().toString(36) + crypto.randomBytes(2).toString('hex');
}
function validId(id) {
  return /^ar[a-z0-9]+$/.test(String(id || ''));
}
async function readFile() {
  try { return JSON.parse(await fs.readFile(FILE, 'utf8')); } catch (e) { return {}; }
}
async function writeFile(all) {
  await fs.writeFile(FILE, JSON.stringify(all, null, 2), 'utf8');
}

async function createRequest({ channelId, channelName, isPrivate, requester, reason, approverId }, teamId = getCurrentTeamId()) {
  const req = {
    id: newId(), teamId, channelId, channelName, isPrivate: !!isPrivate,
    requester, reason, approverId, status: 'pending', createdAt: new Date().toISOString()
  };
  if (db.isDbEnabled()) {
    await db.query('INSERT INTO access_requests (team_id, id, status, data) VALUES ($1,$2,$3,$4)', [teamId, req.id, 'pending', JSON.stringify(req)]);
  } else {
    const all = await readFile(); all[req.id] = req; await writeFile(all);
  }
  return req;
}

async function getRequest(id, teamId = getCurrentTeamId()) {
  if (!validId(id)) return null;
  if (db.isDbEnabled()) {
    const { rows } = await db.query('SELECT data FROM access_requests WHERE team_id=$1 AND id=$2', [teamId, id]);
    return rows.length ? rows[0].data : null;
  }
  const all = await readFile();
  return all[id] || null;
}

// Set status only if still pending (prevents double approve/deny). Returns the
// updated request, or null if not found / already decided.
async function decide(id, status, extra = {}, teamId = getCurrentTeamId()) {
  const req = await getRequest(id, teamId);
  if (!req || req.status !== 'pending') return null;
  req.status = status;
  req.decidedAt = new Date().toISOString();
  Object.assign(req, extra);
  if (db.isDbEnabled()) {
    await db.query('UPDATE access_requests SET status=$3, data=$4 WHERE team_id=$1 AND id=$2 AND status=$5', [teamId, id, status, JSON.stringify(req), 'pending']);
  } else {
    const all = await readFile(); all[id] = req; await writeFile(all);
  }
  return req;
}

module.exports = { createRequest, getRequest, decide, validId };
