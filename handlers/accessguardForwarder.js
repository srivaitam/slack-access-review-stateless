/**
 * accessguardForwarder — proxy Slack interactivity payloads owned by
 * AccessGuard into AccessGuard's `/api/slack/interactions` endpoint.
 *
 * A single Slack app can only have ONE Interactivity URL. When we consolidate
 * Access Review v3 + AccessGuard onto one Slack app, this app owns that URL
 * (`/slack/actions`, in index.js). Any button whose `action_id` is prefixed
 * with `ag:` (AccessGuard-namespaced — e.g. `ag:ack`, `ag:snooze`,
 * `ag:approve`, `ag:deny`) is not for us; we forward it to AccessGuard so the
 * user still gets 1-click alert acknowledgement and access-request approval.
 *
 * Config:
 *   ACCESSGUARD_BASE_URL     e.g. https://app.vaitam.com
 *   ACCESSGUARD_API_KEY      shared secret (same one the REST bridge uses)
 * If either is missing, the forwarder is disabled and payloads are dropped
 * with a warning — the button click still gets a 200 ack from Slack.
 */
const { logInfo, logError, logWarn } = require('../utils/logger');

// Simple prefix used by AccessGuard-owned action_ids. Adjust in AccessGuard's
// interaction handlers if you rename these.
const AG_PREFIX = 'ag:';

function isAccessGuardPayload(payload) {
  // Common shapes: block_actions with actions[], view_submission callback IDs,
  // and message shortcuts. We check the most common carrier fields.
  if (!payload) return false;
  const actionId = payload.actions && payload.actions[0] && payload.actions[0].action_id;
  if (actionId && actionId.startsWith(AG_PREFIX)) return true;
  const callbackId = (payload.view && payload.view.callback_id) || payload.callback_id;
  if (callbackId && callbackId.startsWith(AG_PREFIX)) return true;
  return false;
}

async function forwardToAccessGuard(payload) {
  const base = process.env.ACCESSGUARD_BASE_URL;
  const key = process.env.ACCESSGUARD_API_KEY;
  if (!base || !key) {
    logWarn('[accessguardForwarder] ACCESSGUARD_BASE_URL/API_KEY not set — dropping AG payload');
    return { forwarded: false, reason: 'not_configured' };
  }
  try {
    // Native fetch is available on Node 18+.
    const res = await fetch(`${base.replace(/\/$/, '')}/api/slack/interactions/proxy`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Access-Guard-Key': key,
      },
      body: JSON.stringify({ payload }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      logError(`[accessguardForwarder] AccessGuard returned ${res.status}: ${text}`);
      return { forwarded: true, ok: false, status: res.status };
    }
    logInfo(`[accessguardForwarder] Forwarded AG payload (${payload.type})`);
    return { forwarded: true, ok: true };
  } catch (e) {
    logError('[accessguardForwarder] forward failed:', e);
    return { forwarded: false, error: String(e.message || e) };
  }
}

module.exports = { isAccessGuardPayload, forwardToAccessGuard, AG_PREFIX };
