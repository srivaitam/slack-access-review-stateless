// Public OAuth 2.0 install flow (Slack "public distribution").
//   GET /slack/install        → 302 to slack.com/oauth/v2/authorize
//   GET /slack/oauth/callback → code exchange via oauth.v2.access → store token
//
// CSRF: the `state` parameter is self-contained and HMAC-signed
// (ts.nonce.signature), so no Redis/session store is needed.
const crypto = require('crypto');
const { WebClient } = require('@slack/web-api');
const { saveInstallation } = require('../services/installationService');
const { invalidateTeamClient } = require('./client');

// Must match the Bot Token Scopes configured at api.slack.com (README §Scopes).
const DEFAULT_SCOPES = [
  'channels:read', 'channels:manage', 'channels:join', 'groups:read', 'groups:write',
  'users:read', 'users:read.email', 'chat:write', 'im:write', 'files:write'
].join(',');

const STATE_TTL_MS = 10 * 60 * 1000;

function isOAuthEnabled() {
  return Boolean(process.env.SLACK_CLIENT_ID && process.env.SLACK_CLIENT_SECRET);
}

function stateSecret() {
  return process.env.SLACK_STATE_SECRET || process.env.SLACK_CLIENT_SECRET;
}

function signState() {
  const ts = Date.now().toString(36);
  const nonce = crypto.randomBytes(8).toString('hex');
  const sig = crypto.createHmac('sha256', stateSecret()).update(ts + '.' + nonce).digest('hex');
  return `${ts}.${nonce}.${sig}`;
}

function verifyState(state) {
  const [ts, nonce, sig] = String(state || '').split('.');
  if (!ts || !nonce || !sig) return false;
  const expected = crypto.createHmac('sha256', stateSecret()).update(ts + '.' + nonce).digest('hex');
  let ok = false;
  try { ok = crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected)); } catch (e) { return false; }
  if (!ok) return false;
  return (Date.now() - parseInt(ts, 36)) < STATE_TTL_MS;
}

function redirectUri(req) {
  if (process.env.PUBLIC_BASE_URL) {
    return process.env.PUBLIC_BASE_URL.replace(/\/$/, '') + '/slack/oauth/callback';
  }
  return `${req.protocol}://${req.get('host')}/slack/oauth/callback`;
}

function buildInstallUrl(req) {
  const params = new URLSearchParams({
    client_id: process.env.SLACK_CLIENT_ID,
    scope: process.env.SLACK_SCOPES || DEFAULT_SCOPES,
    state: signState(),
    redirect_uri: redirectUri(req)
  });
  return 'https://slack.com/oauth/v2/authorize?' + params.toString();
}

function page(title, body) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<style>body{font-family:system-ui,sans-serif;max-width:560px;margin:80px auto;padding:0 20px;color:#1d1c1d}h1{font-size:1.4rem}</style>
</head><body><h1>${title}</h1><p>${body}</p></body></html>`;
}

/** GET /slack/install */
function handleInstall(req, res) {
  if (!isOAuthEnabled()) {
    return res.status(503).send(page('Install unavailable', 'OAuth is not configured on this server (SLACK_CLIENT_ID / SLACK_CLIENT_SECRET missing).'));
  }
  res.redirect(302, buildInstallUrl(req));
}

/** GET /slack/oauth/callback */
async function handleOAuthCallback(req, res) {
  if (!isOAuthEnabled()) return res.status(503).send(page('Install unavailable', 'OAuth is not configured on this server.'));
  const { code, state, error } = req.query;

  if (error) {
    return res.status(400).send(page('Installation cancelled', `Slack reported: <code>${String(error).replace(/[<>&]/g, '')}</code>. You can close this tab and try again.`));
  }
  if (!verifyState(state)) {
    return res.status(400).send(page('Invalid or expired install link', 'Please restart the install from the “Add to Slack” button.'));
  }
  if (!code) return res.status(400).send(page('Missing code', 'No authorization code was provided by Slack.'));

  try {
    const result = await new WebClient().oauth.v2.access({
      client_id: process.env.SLACK_CLIENT_ID,
      client_secret: process.env.SLACK_CLIENT_SECRET,
      code,
      redirect_uri: redirectUri(req)
    });

    const teamId = result.team && result.team.id;
    if (!result.access_token || !teamId) throw new Error('oauth.v2.access returned no bot token/team');

    await saveInstallation({
      teamId,
      teamName: result.team.name,
      enterpriseId: result.enterprise && result.enterprise.id,
      botUserId: result.bot_user_id,
      botToken: result.access_token,
      scopes: result.scope,
      installedBy: result.authed_user && result.authed_user.id
    });
    invalidateTeamClient(teamId);

    console.log('[OAUTH] installed to team', teamId, '(' + (result.team.name || 'unnamed') + ')');
    return res.send(page('✅ App installed',
      `Access Review is now installed in <b>${(result.team.name || 'your workspace').replace(/[<>&]/g, '')}</b>. ` +
      'Open Slack → Apps → <b>Access Review</b> → Home tab to get started (workspace owners/admins only).'));
  } catch (e) {
    console.error('[OAUTH] callback failed:', e.data ? JSON.stringify(e.data) : e.message);
    return res.status(500).send(page('Installation failed', 'The token exchange with Slack failed. Please try again; if it keeps happening, contact support.'));
  }
}

module.exports = { isOAuthEnabled, handleInstall, handleOAuthCallback, buildInstallUrl };
