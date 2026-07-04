const { slack } = require('../slack/client');

/**
 * Fail-closed workspace authorization check.
 * Returns true ONLY if Slack confirms the user is a workspace owner or admin.
 * Any error (API failure, unknown user) returns false so privileged actions
 * are denied by default.
 */
async function isWorkspaceAdmin(userId) {
  if (!userId) return false;
  try {
    const info = await slack.users.info({ user: userId });
    return Boolean(info.user && (info.user.is_owner || info.user.is_admin));
  } catch (err) {
    console.error('[AUTHZ] admin check failed for ' + userId + ':', err.message);
    return false; // fail closed
  }
}

module.exports = { isWorkspaceAdmin };
