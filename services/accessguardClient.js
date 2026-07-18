/**
 * accessguardClient — pull data FROM AccessGuard into this Slack app.
 *
 * Mirror image of handlers/accessguardApi.js (where AccessGuard pulls FROM us).
 * Here WE are the client: the Alerts tab fetches a workspace's behavioral
 * alerts from AccessGuard and renders them on the App Home.
 *
 * Config (same shared secret + base URL the interactivity forwarder uses):
 *   ACCESSGUARD_BASE_URL   e.g. https://accessguard-prod-api.onrender.com
 *   ACCESSGUARD_API_KEY    shared secret, sent as X-Access-Guard-Key
 *
 * fetchAlerts never throws. It returns a small status object so the Alerts tab
 * can show the EXACT reason on screen instead of a generic error:
 *   { configured:false }                      → env vars not set
 *   { configured:true, ok:false, reason, target }  → couldn't reach / non-200
 *   { configured:true, ok:true, connected, alerts } → reached AccessGuard
 * (connected:false = reached, but this workspace's team_id isn't linked to a
 * tenant on the AccessGuard side.)
 */
const { logError, logWarn } = require('../utils/logger');
const { getCurrentTeamId } = require('../slack/client');

function agConfig() {
  return {
    base: (process.env.ACCESSGUARD_BASE_URL || '').replace(/\/$/, ''),
    key: process.env.ACCESSGUARD_API_KEY || '',
  };
}

function isAccessGuardConfigured() {
  const { base, key } = agConfig();
  return Boolean(base && key);
}

async function fetchAlerts({ teamId = getCurrentTeamId(), limit = 25 } = {}) {
  const { base, key } = agConfig();
  if (!base || !key) {
    logWarn('[accessguardClient] ACCESSGUARD_BASE_URL/API_KEY not set — cannot fetch alerts');
    return {
      configured: false,
      ok: false,
      connected: false,
      alerts: [],
      reason: 'ACCESSGUARD_BASE_URL / ACCESSGUARD_API_KEY not set on this app',
    };
  }
  const target = `${base}/api/slack/alerts`;
  try {
    const url = `${target}?team_id=${encodeURIComponent(teamId || '')}&limit=${encodeURIComponent(limit)}`;
    // Native fetch is available on Node 18+.
    const res = await fetch(url, {
      method: 'GET',
      headers: { 'X-Access-Guard-Key': key, Accept: 'application/json' },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      logError(`[accessguardClient] alerts returned ${res.status}: ${text.slice(0, 200)}`);
      const hint = res.status === 401 ? ' (API key mismatch)'
        : res.status === 404 ? ' (wrong base URL, or backend not deployed)'
        : res.status === 400 ? ' (missing team_id)'
        : '';
      return {
        configured: true, ok: false, connected: false, alerts: [],
        reason: `HTTP ${res.status}${hint}`, target, teamId,
      };
    }
    const data = await res.json().catch(() => ({}));
    return {
      configured: true,
      ok: true,
      connected: data.connected !== false,
      alerts: Array.isArray(data.alerts) ? data.alerts : [],
      target,
      teamId,
    };
  } catch (e) {
    logError('[accessguardClient] fetch failed:', e.message);
    return {
      configured: true, ok: false, connected: false, alerts: [],
      reason: `Network error: ${String(e.message || e).slice(0, 120)}`, target, teamId,
    };
  }
}

module.exports = { fetchAlerts, isAccessGuardConfigured };
