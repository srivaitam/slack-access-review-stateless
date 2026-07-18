/**
 * accessguardClient — pull data FROM AccessGuard into this Slack app.
 *
 * This is the mirror image of handlers/accessguardApi.js (where AccessGuard
 * pulls campaigns/audit/insights FROM us). Here WE are the client: the Alerts
 * tab fetches a workspace's behavioral alerts from AccessGuard and renders them
 * on the App Home.
 *
 * Config (same shared secret + base URL the interactivity forwarder uses):
 *   ACCESSGUARD_BASE_URL   e.g. https://app.vaitam.com
 *   ACCESSGUARD_API_KEY    shared secret, sent as X-Access-Guard-Key
 * AccessGuard maps our Slack team_id → its tenant (Organization.slack_team_id)
 * and returns that tenant's open UBA alerts. If either env var is missing the
 * client reports "not configured" and the tab renders a setup hint (no throw).
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

/**
 * Fetch recent open behavioral alerts for this workspace from AccessGuard.
 * Returns { configured, connected, alerts: [] }. Never throws — on any failure
 * it returns an empty list with connected:false so the caller can render a
 * clean empty/error state rather than a stack trace.
 */
async function fetchAlerts({ teamId = getCurrentTeamId(), limit = 25 } = {}) {
  const { base, key } = agConfig();
  if (!base || !key) {
    logWarn('[accessguardClient] ACCESSGUARD_BASE_URL/API_KEY not set — cannot fetch alerts');
    return { configured: false, connected: false, alerts: [] };
  }
  try {
    const url = `${base}/api/slack/alerts?team_id=${encodeURIComponent(teamId || '')}&limit=${encodeURIComponent(limit)}`;
    // Native fetch is available on Node 18+.
    const res = await fetch(url, {
      method: 'GET',
      headers: { 'X-Access-Guard-Key': key, Accept: 'application/json' },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      logError(`[accessguardClient] alerts returned ${res.status}: ${text.slice(0, 200)}`);
      return { configured: true, connected: false, alerts: [], error: `HTTP ${res.status}` };
    }
    const data = await res.json().catch(() => ({}));
    return {
      configured: true,
      connected: data.connected !== false,
      alerts: Array.isArray(data.alerts) ? data.alerts : [],
    };
  } catch (e) {
    logError('[accessguardClient] fetch failed:', e.message);
    return { configured: true, connected: false, alerts: [], error: String(e.message || e) };
  }
}

module.exports = { fetchAlerts, isAccessGuardConfigured };
