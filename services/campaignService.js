const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const { logAuditEvent } = require('./auditService');
const db = require('../utils/db');
const { getCurrentTeamId } = require('../slack/client');

// F-003/F-005: campaign + decision store. Dual-mode:
//   - DB mode (DATABASE_URL): one row per campaign in the campaigns table,
//     keyed by (team_id, id) — required for multi-workspace public
//     distribution. Mutations take a row lock (SELECT ... FOR UPDATE).
//   - File mode: original single-workspace JSON files under CAMPAIGN_DIR
//     (dev/tests).
// Every decision is ALSO chained into the tamper-evident audit log, so the
// campaign store is a working state/progress view while the audit chain is
// the authoritative evidence trail.
const CAMPAIGN_DIR = process.env.CAMPAIGN_DIR || './campaigns';

// Serialize writes so concurrent decisions can't clobber a campaign file.
let writeChain = Promise.resolve();
function enqueue(task) {
  const run = writeChain.then(task, task);
  writeChain = run.then(() => {}, () => {});
  return run;
}

function campaignFile(id) {
  // ids are generated internally (base36); sanitize anyway — never trust a
  // client-supplied id to build a path.
  if (!/^c[a-z0-9]+$/.test(id)) throw new Error('Invalid campaign id');
  return path.join(CAMPAIGN_DIR, `campaign-${id}.json`);
}

function newCampaignId() {
  return 'c' + Date.now().toString(36) + crypto.randomBytes(2).toString('hex');
}

// ── Storage primitives (dual-mode) ─────────────────────────────────────────

async function saveCampaign(campaign) {
  if (db.isDbEnabled()) {
    const teamId = campaign.teamId || getCurrentTeamId();
    await db.query(`
      INSERT INTO campaigns (team_id, id, status, created_at, data)
      VALUES ($1,$2,$3,$4,$5)
      ON CONFLICT (team_id, id) DO UPDATE SET status = EXCLUDED.status, data = EXCLUDED.data
    `, [teamId, campaign.id, campaign.status, campaign.createdAt, JSON.stringify(campaign)]);
    return campaign;
  }
  return enqueue(async () => {
    await fs.mkdir(CAMPAIGN_DIR, { recursive: true });
    const tmp = campaignFile(campaign.id) + '.tmp';
    await fs.writeFile(tmp, JSON.stringify(campaign, null, 2), 'utf8');
    await fs.rename(tmp, campaignFile(campaign.id));
    return campaign;
  });
}

async function getCampaign(id, teamId = getCurrentTeamId()) {
  if (db.isDbEnabled()) {
    if (!/^c[a-z0-9]+$/.test(String(id))) return null;
    const { rows } = await db.query('SELECT data FROM campaigns WHERE team_id = $1 AND id = $2', [teamId, id]);
    return rows.length ? rows[0].data : null;
  }
  try {
    return JSON.parse(await fs.readFile(campaignFile(id), 'utf8'));
  } catch (e) {
    return null;
  }
}

async function listCampaigns({ activeOnly = false, teamId = getCurrentTeamId() } = {}) {
  if (db.isDbEnabled()) {
    const { rows } = await db.query(
      activeOnly
        ? "SELECT data FROM campaigns WHERE team_id = $1 AND status = 'active'"
        : 'SELECT data FROM campaigns WHERE team_id = $1',
      [teamId]);
    return rows.map(r => r.data)
      .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  }
  let names;
  try { names = await fs.readdir(CAMPAIGN_DIR); }
  catch (e) { return []; }
  const out = [];
  for (const n of names) {
    if (!/^campaign-c[a-z0-9]+\.json$/.test(n)) continue;
    try {
      const c = JSON.parse(await fs.readFile(path.join(CAMPAIGN_DIR, n), 'utf8'));
      if (!activeOnly || c.status === 'active') out.push(c);
    } catch (e) { /* skip unreadable file */ }
  }
  return out.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
}

/**
 * Read-modify-write a campaign atomically. mutate(campaign) returns a result
 * object; if it returns {ok:true}, the campaign is persisted.
 * DB mode: row lock in a transaction (safe across instances).
 * File mode: in-process queue (original behaviour).
 */
async function mutateCampaign(id, mutate) {
  if (db.isDbEnabled()) {
    const teamId = getCurrentTeamId();
    if (!/^c[a-z0-9]+$/.test(String(id))) return { ok: false, error: 'Campaign not found' };
    return db.withTx(async client => {
      const { rows } = await client.query(
        'SELECT data FROM campaigns WHERE team_id = $1 AND id = $2 FOR UPDATE', [teamId, id]);
      if (!rows.length) return { ok: false, error: 'Campaign not found' };
      const campaign = rows[0].data;
      const result = await mutate(campaign);
      if (result && result.ok) {
        await client.query(
          'UPDATE campaigns SET status = $3, data = $4 WHERE team_id = $1 AND id = $2',
          [teamId, id, campaign.status, JSON.stringify(campaign)]);
      }
      return result;
    });
  }
  return enqueue(async () => {
    const campaign = await getCampaign(id);
    if (!campaign) return { ok: false, error: 'Campaign not found' };
    const result = await mutate(campaign);
    if (result && result.ok) {
      await fs.mkdir(CAMPAIGN_DIR, { recursive: true });
      const tmp = campaignFile(campaign.id) + '.tmp';
      await fs.writeFile(tmp, JSON.stringify(campaign, null, 2), 'utf8');
      await fs.rename(tmp, campaignFile(campaign.id));
    }
    return result;
  });
}

// ── Domain logic ───────────────────────────────────────────────────────────

/**
 * Create a campaign from a snapshot.
 * scope: 'all' | 'private' | 'high_risk'
 * Reviewer per channel: the channel creator if still an active member of the
 * workspace, else the campaign creator (fallback reviewer).
 */
function buildCampaign({ name, scope, dueDate, recurrence, createdBy, snapshot }) {
  const userIds = new Set(snapshot.users.filter(u => u.active).map(u => u.id));
  const inScope = snapshot.channels.filter(({ channel, riskScore, errored }) => {
    if (errored) return false;
    if (scope === 'private') return channel.is_private;
    if (scope === 'high_risk') return riskScore >= 70;
    return true;
  });

  return {
    id: newCampaignId(),
    teamId: getCurrentTeamId(),
    name: String(name).slice(0, 120),
    scope,
    dueDate,                    // 'YYYY-MM-DD'
    recurrence,                 // 'none' | 'monthly' | 'quarterly'
    status: 'active',
    createdBy,                  // {id, name, email}
    createdAt: new Date().toISOString(),
    closedAt: null,
    channels: inScope.map(({ channel, members, riskScore }) => ({
      id: channel.id,
      name: channel.name,
      is_private: channel.is_private,
      riskScore,
      reviewerId: (channel.creator && userIds.has(channel.creator)) ? channel.creator : createdBy.id,
      members: members.map(m => ({ id: m.id, name: m.name, email: m.email, role: m.role, active: m.active })),
      decisions: {}             // userId -> {decision, reviewer:{id,name,email}, timestamp, justification}
    }))
  };
}

async function createCampaign(opts) {
  const campaign = buildCampaign(opts);
  await saveCampaign(campaign);
  await logAuditEvent({
    action: 'REVIEW_CAMPAIGN_CREATED',
    actor: opts.createdBy,
    target: { campaignId: campaign.id, name: campaign.name },
    result: { channels: campaign.channels.length, scope: campaign.scope, dueDate: campaign.dueDate },
    reason: 'Access review campaign created',
    metadata: { recurrence: campaign.recurrence }
  });
  return campaign;
}

/**
 * F-005: record one membership decision. Persists to the campaign store AND
 * the tamper-evident audit chain. Returns {ok, campaign, error}.
 * Authorization: reviewer must be the channel's assigned reviewer or a
 * workspace admin (checked by the caller via isWorkspaceAdmin — this module
 * enforces assigned-reviewer identity only).
 */
async function recordDecision({ campaignId, channelId, targetUserId, decision, reviewer, justification, reviewerIsAdmin = false }) {
  if (!['keep', 'remove', 'flag'].includes(decision)) return { ok: false, error: 'Invalid decision' };

  const result = await mutateCampaign(campaignId, campaign => {
    if (campaign.status !== 'active') return { ok: false, error: 'Campaign is closed' };
    const ch = campaign.channels.find(c => c.id === channelId);
    if (!ch) return { ok: false, error: 'Channel not in campaign' };
    if (ch.reviewerId !== reviewer.id && !reviewerIsAdmin) {
      return { ok: false, error: 'Only the assigned reviewer (or an admin) can review this channel' };
    }
    if (!ch.members.some(m => m.id === targetUserId)) return { ok: false, error: 'User not in channel scope' };

    ch.decisions[targetUserId] = {
      decision,
      reviewer: { id: reviewer.id, name: reviewer.name, email: reviewer.email },
      timestamp: new Date().toISOString(),
      justification: justification || null
    };

    // Auto-close when every member of every channel has a decision.
    if (campaign.channels.every(c => c.members.every(m => c.decisions[m.id]))) {
      campaign.status = 'completed';
      campaign.closedAt = new Date().toISOString();
    }
    return { ok: true, campaign, channel: ch };
  });

  if (result.ok) {
    const member = result.channel.members.find(m => m.id === targetUserId);
    await logAuditEvent({
      action: 'REVIEW_DECISION',
      actor: reviewer,
      target: { userId: targetUserId, userName: member?.name, userEmail: member?.email, channelId, channelName: result.channel.name },
      result: { decision },
      reason: justification || `Reviewer decision: ${decision}`,
      metadata: { campaignId }
    });
  }
  return result;
}

/**
 * F-005 (bulk): record MANY membership decisions for one channel in a single
 * atomic mutateCampaign, then chain each into the audit log. Same authorization
 * as recordDecision (assigned reviewer or admin). Invalid rows are skipped and
 * returned in `errors`; at least one valid decision must apply.
 * Returns {ok, campaign, applied:[{targetUserId,decision}], errors:[...]}.
 */
async function recordDecisions({ campaignId, channelId, decisions, reviewer, reviewerIsAdmin = false }) {
  if (!Array.isArray(decisions) || decisions.length === 0) return { ok: false, error: 'No decisions provided' };

  const applied = [];
  const errors = [];

  const result = await mutateCampaign(campaignId, campaign => {
    if (campaign.status !== 'active') return { ok: false, error: 'Campaign is closed' };
    const ch = campaign.channels.find(c => c.id === channelId);
    if (!ch) return { ok: false, error: 'Channel not in campaign' };
    if (ch.reviewerId !== reviewer.id && !reviewerIsAdmin) {
      return { ok: false, error: 'Only the assigned reviewer (or an admin) can review this channel' };
    }
    const timestamp = new Date().toISOString();
    for (const d of decisions) {
      if (!['keep', 'remove', 'flag'].includes(d.decision)) { errors.push({ targetUserId: d.targetUserId, error: 'Invalid decision' }); continue; }
      const member = ch.members.find(m => m.id === d.targetUserId);
      if (!member) { errors.push({ targetUserId: d.targetUserId, error: 'User not in channel scope' }); continue; }
      ch.decisions[d.targetUserId] = {
        decision: d.decision,
        reviewer: { id: reviewer.id, name: reviewer.name, email: reviewer.email },
        timestamp,
        justification: d.justification || null
      };
      applied.push({ targetUserId: d.targetUserId, decision: d.decision, justification: d.justification || null, member: { name: member.name, email: member.email } });
    }
    if (applied.length === 0) return { ok: false, error: (errors[0] && errors[0].error) || 'No valid decisions' };

    // Auto-close when every member of every channel has a decision.
    if (campaign.channels.every(c => c.members.every(m => c.decisions[m.id]))) {
      campaign.status = 'completed';
      campaign.closedAt = new Date().toISOString();
    }
    return { ok: true, campaign, channel: ch };
  });

  if (!result.ok) return { ok: false, error: result.error, errors };

  for (const a of applied) {
    await logAuditEvent({
      action: 'REVIEW_DECISION',
      actor: reviewer,
      target: { userId: a.targetUserId, userName: a.member.name, userEmail: a.member.email, channelId, channelName: result.channel.name },
      result: { decision: a.decision },
      reason: a.justification || `Reviewer decision: ${a.decision}`,
      metadata: { campaignId, bulk: true }
    });
  }
  return { ok: true, campaign: result.campaign, applied, errors };
}

function campaignProgress(campaign) {
  let total = 0, decided = 0, removals = 0, flags = 0;
  for (const ch of campaign.channels) {
    total += ch.members.length;
    for (const m of ch.members) {
      const d = ch.decisions[m.id];
      if (d) {
        decided++;
        if (d.decision === 'remove') removals++;
        if (d.decision === 'flag') flags++;
      }
    }
  }
  return { total, decided, removals, flags, percent: total ? Math.round((decided / total) * 100) : 100 };
}

/**
 * F-003 recurrence: for each completed (or overdue) recurring campaign that
 * hasn't spawned a successor yet, mark it and return it so the caller can
 * launch the next occurrence with a fresh snapshot. Team-scoped.
 */
async function findCampaignsNeedingRecurrence() {
  const all = await listCampaigns();
  const today = new Date().toISOString().slice(0, 10);
  return all.filter(c =>
    c.recurrence && c.recurrence !== 'none' && !c.nextSpawned &&
    (c.status === 'completed' || (c.status === 'active' && c.dueDate && c.dueDate < today))
  );
}

function nextDueDate(dueDate, recurrence) {
  const d = new Date((dueDate || new Date().toISOString().slice(0, 10)) + 'T00:00:00Z');
  d.setUTCMonth(d.getUTCMonth() + (recurrence === 'monthly' ? 1 : 3));
  return d.toISOString().slice(0, 10);
}

async function markRecurrenceSpawned(id) {
  return mutateCampaign(id, c => {
    c.nextSpawned = true;
    if (c.status === 'active') { c.status = 'expired'; c.closedAt = new Date().toISOString(); }
    return { ok: true };
  });
}

module.exports = {
  createCampaign,
  getCampaign,
  listCampaigns,
  recordDecision,
  recordDecisions,
  campaignProgress,
  findCampaignsNeedingRecurrence,
  nextDueDate,
  markRecurrenceSpawned
};
// F-006: recordDecisions (batch) added for the App Home review flow.
