// Multi-workspace Slack client.
//
// Public-distribution mode: each installing workspace has its own bot token
// (services/installationService). index.js resolves the token for the
// request's team_id and runs the handler inside an AsyncLocalStorage context;
// the exported `slack` proxy transparently routes every existing call site
// (slack.chat.postMessage, slack.users.info, ...) to that workspace's client.
//
// Legacy single-workspace mode: if SLACK_BOT_TOKEN is set and there is no
// team context (or no installation row), calls fall back to the env-token
// client — original behaviour, and what the tests rely on.
const { WebClient } = require('@slack/web-api');
const { AsyncLocalStorage } = require('async_hooks');

const als = new AsyncLocalStorage();

const clientOptions = {
  retryConfig: { retries: 3, factor: 2 },
  timeout: Number(process.env.SLACK_TIMEOUT_MS || 15000), // M4: bound each call
  maxRequestConcurrency: Number(process.env.SLACK_MAX_CONCURRENCY || 10) // R3: global cap on all calls (incl. writes)
};

let _legacyClient = null;
function legacyClient() {
  if (!_legacyClient) {
    if (!process.env.SLACK_BOT_TOKEN) {
      throw new Error('No Slack client available: no team context and SLACK_BOT_TOKEN is not set');
    }
    _legacyClient = new WebClient(process.env.SLACK_BOT_TOKEN, clientOptions);
  }
  return _legacyClient;
}

function currentClient() {
  const store = als.getStore();
  if (store && store.client) return store.client;
  return legacyClient();
}

// Drop-in replacement for the old singleton export.
const slack = new Proxy({}, {
  get(_t, prop) { return currentClient()[prop]; },
  set(_t, prop, value) { currentClient()[prop] = value; return true; },
  has(_t, prop) { return prop in currentClient(); }
});

// team_id -> { client, at } — avoids a DB read per Slack call.
const _teamClients = new Map();
const CLIENT_CACHE_TTL_MS = Number(process.env.CLIENT_CACHE_TTL_MS || 10 * 60 * 1000);

/** Resolve the WebClient for a workspace (installation row, else legacy env token). */
async function getClientForTeam(teamId) {
  if (!teamId) return legacyClient();
  const cached = _teamClients.get(teamId);
  if (cached && (Date.now() - cached.at) < CLIENT_CACHE_TTL_MS) return cached.client;

  const { getInstallation } = require('../services/installationService');
  const inst = await getInstallation(teamId).catch(err => {
    console.error('[CLIENT] installation lookup failed for', teamId, err.message);
    return null;
  });
  if (inst) {
    const client = new WebClient(inst.botToken, clientOptions);
    _teamClients.set(teamId, { client, at: Date.now() });
    return client;
  }
  return legacyClient();
}

/** Run fn with a team-scoped Slack client (propagates through async calls, setImmediate, timers). */
function runWithTeam(teamId, client, fn) {
  return als.run({ teamId, client }, fn);
}

/** The team the current async context is serving. 'default' in legacy mode. */
function getCurrentTeamId() {
  return (als.getStore() && als.getStore().teamId) || 'default';
}

/** Forget a cached client (call on app_uninstalled / tokens_revoked). */
function invalidateTeamClient(teamId) {
  _teamClients.delete(teamId);
}

module.exports = { slack, getClientForTeam, runWithTeam, getCurrentTeamId, invalidateTeamClient };
