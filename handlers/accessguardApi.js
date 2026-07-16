/**
 * accessguardApi — REST bridge for AccessGuard.
 *
 * AccessGuard (the governance UI at app.vaitam.com) consumes these endpoints
 * to surface Access Review v3's real campaigns and tamper-evident audit chain
 * inside its Slack workspace page (/slack/workspace).
 *
 * Auth: shared secret in the `X-Access-Guard-Key` header. Set the same value
 * in this app's env (`ACCESSGUARD_API_KEY`) and in AccessGuard's tenant Slack
 * bridge settings. Requests without a matching key return 401.
 *
 * All routes are read-only; nothing here can mutate campaign or audit state.
 */
const { listCampaigns, campaignProgress } = require('../services/campaignService');
const { readAllEntries } = require('../services/auditService');
const { logInfo, logError } = require('../utils/logger');

function requireApiKey(req, res, next) {
  const expected = process.env.ACCESSGUARD_API_KEY;
  if (!expected) {
    return res.status(503).json({
      error: 'ACCESSGUARD_API_KEY not set on this Access Review v3 install',
    });
  }
  const provided = req.headers['x-access-guard-key'];
  if (!provided || provided !== expected) {
    return res.status(401).json({ error: 'invalid or missing X-Access-Guard-Key' });
  }
  next();
}

/**
 * Resolve which team IDs to query. If the caller passes team_id, use just
 * that one. Otherwise iterate every installed workspace so a single call
 * returns campaigns / audit across the whole install base.
 */
async function resolveTeamIds(explicit) {
  if (explicit) return [explicit];
  try {
    const { listInstallations } = require('../services/installationService');
    const teams = await listInstallations();
    return (teams || []).map((t) => t.teamId).filter(Boolean);
  } catch (e) {
    logError('[accessguardApi] listInstallations failed:', e);
    return [];
  }
}

/**
 * Run fn inside each team's context and concatenate the returned arrays.
 * Errors on one team never block the others.
 */
async function collectAcrossTeams(withTeamContext, teamIds, fn) {
  const out = [];
  for (const tid of teamIds) {
    try {
      const rows = await withTeamContext(tid, () => fn(tid));
      if (Array.isArray(rows)) out.push(...rows);
    } catch (e) {
      logError(`[accessguardApi] team ${tid} failed:`, e.message);
    }
  }
  return out;
}

/**
 * GET /api/v1/campaigns[?team_id=T…]
 * Returns every campaign (active + completed) across the requested team(s),
 * enriched with progress + removal / flag counts for AccessGuard's UI.
 */
function makeCampaignsHandler(withTeamContext) {
  return async function campaignsHandler(req, res) {
    try {
      const teamIds = await resolveTeamIds(req.query.team_id);
      const rows = await collectAcrossTeams(withTeamContext, teamIds, async (tid) => {
        const list = await listCampaigns({ activeOnly: false });
        return Promise.all((list || []).map(async (c) => {
          let progress = { reviewed: 0, total: 0 };
          try {
            const p = await campaignProgress(c.id);
            progress = { reviewed: p.reviewed || 0, total: p.total || 0 };
          } catch (_) { /* progress optional */ }
          const decisions = Object.values(c.decisions || {}).flatMap(m => Object.values(m || {}));
          const removals = decisions.filter(d => (d.decision || '').toLowerCase() === 'remove').length;
          const flags = decisions.filter(d => (d.decision || '').toLowerCase() === 'flag').length;
          const dueAt = c.dueDate ? new Date(c.dueDate).toISOString() : null;
          const isOverdue = c.dueDate && new Date(c.dueDate) < new Date() && progress.reviewed < progress.total;
          return {
            id: c.id,
            name: c.name,
            scope: c.scope,
            due_at: dueAt,
            recurrence: c.recurrence || 'one-off',
            status: c.status || (isOverdue ? 'overdue' : 'active'),
            progress,
            removals,
            flags,
            created_by: c.createdBy || null,
            created_at: c.createdAt || null,
            team_id: c.teamId || tid,
          };
        }));
      });
      res.json({ campaigns: rows });
    } catch (e) {
      logError('[accessguardApi] campaigns handler failed:', e);
      res.status(500).json({ error: String(e.message || e) });
    }
  };
}

/**
 * GET /api/v1/audit[?team_id=T…&limit=100]
 * Returns hash-chained audit rows across the requested team(s), newest first.
 */
function makeAuditHandler(withTeamContext) {
  return async function auditHandler(req, res) {
    try {
      const limit = Math.min(Number(req.query.limit) || 100, 1000);
      const teamIds = await resolveTeamIds(req.query.team_id);
      const rows = await collectAcrossTeams(withTeamContext, teamIds, async (tid) => {
        const entries = await readAllEntries();
        return (entries || []).map((e) => ({
          timestamp: e.timestamp || e.ts || null,
          actor: (e.actor && (e.actor.userName || e.actor.userId)) || e.actorEmail || 'system',
          action: e.eventType || e.action || 'event',
          target: (e.target && (e.target.name || e.target.channelName || e.target.userName)) || null,
          event_type: e.eventType || null,
          team_id: e.teamId || tid,
          hash: e.hash || null,
          prev_hash: e.prevHash || null,
          details: e.details || null,
        }));
      });
      rows.sort((a, b) => String(b.timestamp || '').localeCompare(String(a.timestamp || '')));
      res.json({ events: rows.slice(0, limit) });
    } catch (e) {
      logError('[accessguardApi] audit handler failed:', e);
      res.status(500).json({ error: String(e.message || e) });
    }
  };
}

/**
 * GET /api/v1/health — cheap liveness ping for AccessGuard's status card.
 * NO team context needed (and no team context possible in OAuth-only mode).
 */
function healthHandler(_req, res) {
  res.json({ ok: true, service: 'access-review-v3', ts: new Date().toISOString() });
}

/**
 * Mount all AccessGuard bridge routes onto the given Express app.
 * All routes require the X-Access-Guard-Key header.
 */
function mount(app, withTeamContext) {
  app.get('/api/v1/health', requireApiKey, healthHandler);
  app.get('/api/v1/campaigns', requireApiKey, makeCampaignsHandler(withTeamContext));
  app.get('/api/v1/audit', requireApiKey, makeAuditHandler(withTeamContext));
  logInfo('[accessguardApi] Mounted /api/v1/{health,campaigns,audit}');
}

module.exports = { mount, requireApiKey };
