// F-008: workspace plan detection + revoke capability gate.
//
// Why: on Free/Pro, removing members from channels is per-channel and usually
// admin-only, so bot revocation fails with `restricted_action`. The workspace
// "Channel Management → remove members" toggle only exists on Business+, and
// full private-channel access needs Enterprise Grid. So we only expose the
// revoke feature on Business+ and Enterprise Grid.
//
// Detection:
//   • Enterprise Grid → auth.test().enterprise_id / is_enterprise_install
//   • Plan tier        → team.billing.info().plan  (needs `team.billing:read`)
//
// Escape hatches (in case a plan string differs or detection can't run):
//   • REVOKE_ENABLED = 'true' | 'false'   → force on/off
//   • REVOKE_ALLOWED_PLANS = 'plus,enterprise'  → override the allowed set
const { slack, getCurrentTeamId } = require('../slack/client');

// team.billing.info plan strings → friendly labels.
const PLAN_LABELS = { '': 'Free', free: 'Free', std: 'Pro', pro: 'Pro', plus: 'Business+', compliance: 'Business+', enterprise: 'Enterprise Grid' };
const DEFAULT_ALLOWED = ['plus', 'compliance', 'enterprise']; // Business+ and Enterprise Grid

const _cache = new Map(); // teamId -> { value, at }
const TTL_MS = Number(process.env.PLAN_CACHE_TTL_MS || 60 * 60 * 1000);

function allowedPlans() {
  if (process.env.REVOKE_ALLOWED_PLANS) {
    return process.env.REVOKE_ALLOWED_PLANS.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  }
  return DEFAULT_ALLOWED;
}

function labelFor(planRaw, isEnterprise) {
  if (isEnterprise) return 'Enterprise Grid';
  if (planRaw == null) return 'Unknown';
  const key = String(planRaw).toLowerCase();
  return PLAN_LABELS[key] || (planRaw === '' ? 'Free' : planRaw);
}

// Pure so it can be unit-tested without Slack.
function computeCanRevoke({ planRaw, isEnterprise }, env = process.env) {
  if (env.REVOKE_ENABLED === 'true') return true;
  if (env.REVOKE_ENABLED === 'false') return false;
  if (isEnterprise) return true;
  // Couldn't detect the plan (team.billing.info unavailable) → fail OPEN. Only a
  // KNOWN Free/Pro plan hides revoke; an unreadable plan shouldn't hide a feature
  // that works. Slack still enforces the actual removal permission and reports a
  // clear error if it isn't allowed.
  if (planRaw == null) return true;
  const allowed = env.REVOKE_ALLOWED_PLANS
    ? env.REVOKE_ALLOWED_PLANS.split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
    : DEFAULT_ALLOWED;
  return allowed.includes(String(planRaw).toLowerCase());
}

async function getWorkspacePlan() {
  const teamId = getCurrentTeamId();
  const cached = _cache.get(teamId);
  if (cached && Date.now() - cached.at < TTL_MS) return cached.value;

  let isEnterprise = false;
  let planRaw = null;

  try {
    const auth = await slack.auth.test();
    isEnterprise = Boolean(auth.enterprise_id || auth.is_enterprise_install);
  } catch (e) {
    console.warn('[PLAN] auth.test failed:', e.data && e.data.error ? e.data.error : e.message);
  }

  try {
    const info = await slack.apiCall('team.billing.info');
    if (info && typeof info.plan === 'string') planRaw = info.plan;
  } catch (e) {
    // Most commonly missing_scope (team.billing:read not granted / not reinstalled).
    console.warn('[PLAN] team.billing.info unavailable:', e.data && e.data.error ? e.data.error : e.message);
  }

  const value = {
    planRaw,
    isEnterprise,
    label: labelFor(planRaw, isEnterprise),
    canRevoke: computeCanRevoke({ planRaw, isEnterprise }),
    detected: isEnterprise || planRaw != null
  };
  _cache.set(teamId, { value, at: Date.now() });
  return value;
}

function invalidatePlanCache(teamId = getCurrentTeamId()) {
  _cache.delete(teamId);
}

module.exports = { getWorkspacePlan, invalidatePlanCache, computeCanRevoke, labelFor, DEFAULT_ALLOWED };
