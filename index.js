require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const crypto = require('crypto');
const { handleEvent } = require('./handlers/eventHandler');
const { handleAction } = require('./handlers/actionHandler');
const { handleViewSubmission } = require('./handlers/viewSubmissionHandler');
const { logInfo, logError } = require('./utils/logger');
const { verifyAllChains, findIncompleteRevocations } = require('./services/auditService');
const { getClientForTeam, runWithTeam } = require('./slack/client');
const { isOAuthEnabled, handleInstall, handleOAuthCallback } = require('./slack/oauth');
const db = require('./utils/db');

const app = express();
// Render (and most PaaS) terminate TLS at a proxy — needed so req.protocol
// resolves to https when deriving the OAuth redirect URI.
app.set('trust proxy', 1);

app.use(bodyParser.json({
  verify: (req, res, buf) => { req.rawBody = buf.toString('utf8'); }
}));
// Capture the raw body for urlencoded requests too — Slack sends interactivity
// (button clicks / modals) as application/x-www-form-urlencoded, and signature
// verification needs the exact raw bytes. Without this, actions return 401.
app.use(bodyParser.urlencoded({
  extended: true,
  verify: (req, res, buf) => { req.rawBody = buf.toString('utf8'); }
}));

app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    mode: db.isDbEnabled() ? 'multi-workspace' : 'single-workspace'
  });
});

// ── Public OAuth install flow (multi-workspace distribution) ───────────────
// Share https://<host>/slack/install as the "Add to Slack" link.
app.get('/slack/install', handleInstall);
app.get('/slack/oauth/callback', handleOAuthCallback);

function verifySignature(req) {
  // Slack signatures are ALWAYS verified. There is no environment bypass:
  // a missing/invalid signature is rejected in every environment.
  // The signing secret is per-APP (not per-workspace), so one secret covers
  // every installing workspace.
  const timestamp = req.headers['x-slack-request-timestamp'];
  const signature = req.headers['x-slack-signature'];
  if (!timestamp || !signature) return false;
  if (Math.abs(Date.now() / 1000 - timestamp) > 300) return false;
  const sigBasestring = 'v0:' + timestamp + ':' + req.rawBody;
  const mySignature = 'v0=' + crypto
    .createHmac('sha256', process.env.SLACK_SIGNING_SECRET)
    .update(sigBasestring)
    .digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(mySignature));
  } catch (e) { return false; }
}

// Resolve the workspace's client and run fn inside its team context, so every
// downstream `slack.*` call (and campaign/audit read/write) is scoped to the
// right workspace. Falls back to the legacy env-token client when the team is
// unknown (single-workspace mode).
async function withTeamContext(teamId, fn) {
  const client = await getClientForTeam(teamId);
  return runWithTeam(teamId, client, fn);
}

// EVENTS - ack immediately, process async
app.post('/slack/events', async (req, res) => {
  if (req.body.type === 'url_verification') {
    return res.json({ challenge: req.body.challenge });
  }
  if (!verifySignature(req)) return res.sendStatus(401);
  res.sendStatus(200); // ack first
  const teamId = req.body.team_id || null;
  withTeamContext(teamId, () => handleEvent(req.body))
    .catch(err => logError('Event error:', err));
});

// ACTIONS (button clicks) - ack immediately, process async
app.post('/slack/actions', async (req, res) => {
  if (!verifySignature(req)) return res.sendStatus(401);

  let payload;
  try {
    payload = JSON.parse(req.body.payload);
  } catch (e) {
    return res.sendStatus(400);
  }

  const teamId = (payload.team && payload.team.id) || (payload.user && payload.user.team_id) || null;

  // VIEW SUBMISSIONS need synchronous response (push/clear/errors)
  // Must respond within 3 seconds WITH the response body
  if (payload.type === 'view_submission') {
    try {
      const response = await withTeamContext(teamId, () => handleViewSubmission(payload));
      if (response) {
        // Return the action response (push modal, clear, errors)
        return res.json(response);
      }
      return res.sendStatus(200);
    } catch (error) {
      logError('View submission error:', error);
      return res.sendStatus(200);
    }
  }

  // All other interactions (button clicks, checkboxes) - ack immediately
  res.sendStatus(200);
  withTeamContext(teamId, () => handleAction(payload))
    .catch(err => logError('Action error:', err));
});

app.use((err, req, res, next) => {
  logError('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// ── Boot-time configuration checks (fail closed in production) ─────────────
// M5: without the signing secret, Slack request authenticity cannot be verified.
if (process.env.NODE_ENV === 'production' && !process.env.SLACK_SIGNING_SECRET) {
  throw new Error('SLACK_SIGNING_SECRET is required in production (cannot verify Slack requests without it)');
}
// Multi-workspace (OAuth) mode needs somewhere safe to keep tokens.
if (isOAuthEnabled()) {
  if (!process.env.SLACK_CLIENT_SECRET) {
    throw new Error('SLACK_CLIENT_SECRET is required when SLACK_CLIENT_ID is set');
  }
  if (process.env.NODE_ENV === 'production') {
    if (!db.isDbEnabled()) throw new Error('DATABASE_URL is required in production for multi-workspace OAuth mode (token storage)');
    if (!process.env.TOKEN_ENCRYPTION_KEY) throw new Error('TOKEN_ENCRYPTION_KEY is required in production to encrypt workspace tokens at rest');
  }
}
// The app needs at least one way to talk to Slack.
if (process.env.NODE_ENV === 'production' && !isOAuthEnabled() && !process.env.SLACK_BOT_TOKEN) {
  throw new Error('Set either SLACK_BOT_TOKEN (single workspace) or SLACK_CLIENT_ID/SLACK_CLIENT_SECRET (public OAuth distribution)');
}

const PORT = process.env.PORT || 3000;

async function start() {
  if (db.isDbEnabled()) {
    await db.ensureSchema();
  }
  app.listen(PORT, () => {
    logInfo('Server running on port ' + PORT);
    logInfo('Mode: ' + (db.isDbEnabled() ? 'multi-workspace (Postgres)' : 'single-workspace (no database)'));
    logInfo('OAuth install flow: ' + (isOAuthEnabled() ? 'ENABLED at /slack/install' : 'disabled (set SLACK_CLIENT_ID/SECRET)'));
    logInfo('Slack signing secret: ' + (process.env.SLACK_SIGNING_SECRET ? 'Configured' : 'MISSING'));
    logInfo('Legacy bot token: ' + (process.env.SLACK_BOT_TOKEN ? 'Configured' : 'not set'));
  });

  runAuditIntegrityCheck();
  const AUDIT_VERIFY_INTERVAL_MS = Number(process.env.AUDIT_VERIFY_INTERVAL_MS || 6 * 60 * 60 * 1000);
  if (AUDIT_VERIFY_INTERVAL_MS > 0) {
    setInterval(runAuditIntegrityCheck, AUDIT_VERIFY_INTERVAL_MS).unref();
  }

  runCampaignRecurrenceCheck();
  setInterval(runCampaignRecurrenceCheck, 24 * 60 * 60 * 1000).unref();
}

// Run fn once per installed workspace (DB mode), or once in legacy
// single-workspace mode. Errors in one team never block the others.
async function forEachWorkspace(label, fn) {
  if (db.isDbEnabled()) {
    const { listInstallations } = require('./services/installationService');
    const teams = await listInstallations();
    for (const t of teams) {
      try {
        await withTeamContext(t.teamId, fn);
      } catch (e) {
        logError(`${label} failed for team ${t.teamId}:`, e.message);
      }
    }
  } else if (process.env.SLACK_BOT_TOKEN) {
    await fn();
  }
}

// Audit integrity: verify the tamper-evident chain and surface any revocation
// that was initiated but never completed (R7/R9). Runs at boot and periodically.
async function runAuditIntegrityCheck() {
  await forEachWorkspace('Audit check', async () => {
    try {
      const chain = await verifyAllChains();
      if (chain.ok) logInfo(`Audit chain OK: ${chain.count} entries across ${chain.files} file(s)`);
      else logError(`AUDIT CHAIN BROKEN in ${chain.file} at #${chain.brokenAt}: ${chain.reason}`);
    } catch (e) { logError('Audit chain verify failed:', e.message); }
    try {
      const incomplete = await findIncompleteRevocations();
      if (incomplete.length) {
        logError(`${incomplete.length} revocation(s) initiated but never completed:`,
          incomplete.map(i => (i.target && i.target.userName) || i.idempotencyKey).join(', '));
      }
    } catch (e) { logError('Reconciliation check failed:', e.message); }
  }).catch(e => logError('Audit integrity sweep failed:', e.message));
}

// F-003 recurrence: spawn the next occurrence of completed/overdue recurring
// campaigns. Runs at boot and daily, per installed workspace.
async function runCampaignRecurrenceCheck() {
  await forEachWorkspace('Recurrence check', async () => {
    try {
      const { findCampaignsNeedingRecurrence, nextDueDate, markRecurrenceSpawned } = require('./services/campaignService');
      const { launchCampaign } = require('./handlers/viewSubmissionHandler');
      const due = await findCampaignsNeedingRecurrence();
      for (const c of due) {
        await markRecurrenceSpawned(c.id); // mark first so a crash can't double-spawn
        await launchCampaign({
          name: c.name.replace(/ \(\d{4}-\d{2}-\d{2}\)$/, '') + ` (${new Date().toISOString().slice(0, 10)})`,
          scope: c.scope,
          dueDate: nextDueDate(c.dueDate, c.recurrence),
          recurrence: c.recurrence,
          createdBy: c.createdBy
        });
        logInfo(`Recurring campaign respawned from ${c.id} (${c.name})`);
      }
    } catch (e) {
      logError('Campaign recurrence check failed:', e.message);
    }
  }).catch(e => logError('Recurrence sweep failed:', e.message));
}

start().catch(err => {
  logError('Fatal startup error:', err);
  process.exit(1);
});
