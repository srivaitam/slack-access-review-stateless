const { slack, getCurrentTeamId } = require('../slack/client');
const { limiters } = require('../slack/rateLimiter');
const { logAuditEvent, hasCompletedRevocation } = require('./auditService');
const { sendRevocationNotification } = require('./notificationService');
const { invalidateSnapshotCache } = require('./accessService');
const pLimit = require('p-limit');

// In-process idempotency guard (H7): dedupe identical revocations within a
// short window so a double-submit / retry doesn't kick the same user twice.
const IDEMPOTENCY_TTL_MS = 10 * 60 * 1000;
const _recentKeys = new Map(); // key -> expiry ts
function _seen(key) {
  if (!key) return false;
  const now = Date.now();
  for (const [k, exp] of _recentKeys) if (exp < now) _recentKeys.delete(k);
  if (_recentKeys.has(key)) return true;
  _recentKeys.set(key, now + IDEMPOTENCY_TTL_MS);
  return false;
}

async function revokeUserAccess({ userId, userName, userEmail, channelIds, reason, revokedBy, notifyUser = true, idempotencyKey = null }) {
  const results = { successful: [], failed: [], skipped: false, auditId: null, idempotencyKey, timestamp: new Date().toISOString() };

  // Durable idempotency across restarts (R9): if the audit log already records a
  // completed revocation for this key, don't repeat it (survives process loss).
  if (idempotencyKey && await hasCompletedRevocation(idempotencyKey)) {
    console.warn('[REVOKE] Already completed (per audit log) for key=' + idempotencyKey);
    results.skipped = true;
    return results;
  }

  // Idempotency: if this exact request was already processed in-process, skip it.
  // Key is namespaced per workspace so teams can never collide.
  if (_seen(idempotencyKey && getCurrentTeamId() + ':' + idempotencyKey)) {
    console.warn('[REVOKE] Duplicate suppressed for key=' + idempotencyKey);
    results.skipped = true;
    return results;
  }

  const limit = pLimit(3);

  const revocationPromises = channelIds.map(channelId =>
    limit(async () => {
      console.log('[REVOKE] Attempting: channel=' + channelId + ' user=' + userId);
      try {

        // Step 1: Make sure bot is in the channel first
        await ensureBotInChannel(channelId);

        // Step 2: Kick the user
        await limiters.tier3.schedule(() => slack.conversations.kick({ channel: channelId, user: userId }));

        console.log('[REVOKE] ✅ Success: channel=' + channelId);
        results.successful.push(channelId);
        return { channelId, status: 'success' };

      } catch (error) {
        const errCode = error.data?.error || error.message || 'unknown_error';
        console.error('[REVOKE] ❌ Failed: channel=' + channelId + ' error=' + errCode);

        // Friendly error messages
        let friendlyError = errCode;
        if (errCode === 'cant_kick_self') friendlyError = 'Cannot remove yourself';
        if (errCode === 'cant_kick_admin') friendlyError = 'Cannot remove workspace admins/owners';
        if (errCode === 'not_in_channel') friendlyError = 'Bot could not join channel';
        if (errCode === 'channel_not_found') friendlyError = 'Channel not found or bot has no access';
        if (errCode === 'missing_scope') friendlyError = 'Bot missing required permission scope';
        if (errCode === 'restricted_action') friendlyError = 'Blocked by a workspace setting — an Owner must allow member removal at Settings → Permissions → Channel Management → "People who can remove members from public channels" (set to "Everyone, except guests").';

        results.failed.push({ channelId, error: friendlyError });
        return { channelId, status: 'failed', error: friendlyError };
      }
    })
  );

  await Promise.all(revocationPromises);

  // Audit log
  results.auditId = await logAuditEvent({
    action: 'ACCESS_REVOKED',
    actor: revokedBy,
    target: { userId, userName, userEmail, channelIds },
    result: {
      successful: results.successful.length,
      failed: results.failed.length,
      failureReasons: results.failed
    },
    reason,
    metadata: { idempotencyKey }
  });

  // Invalidate the cached snapshot so the dashboard reflects the change (R1)
  if (results.successful.length > 0) {
    invalidateSnapshotCache();
  }

  // Notify user if any succeeded
  if (notifyUser && results.successful.length > 0) {
    await sendRevocationNotification({ userId, userName, channelIds: results.successful, reason });
  }

  return results;
}

// Ensure bot is a member of the channel so it can kick users
async function ensureBotInChannel(channelId) {
  try {
    // Try joining the channel (works for public channels)
    await limiters.tier3.schedule(() => slack.conversations.join({ channel: channelId }));
    console.log('[REVOKE] Bot joined channel: ' + channelId);
  } catch (joinError) {
    const errCode = joinError.data?.error || joinError.message;

    // Already in channel - that's fine
    if (errCode === 'already_in_channel') {
      return;
    }

    // Private channel - bot must be manually invited, can't auto-join
    if (errCode === 'method_not_supported_for_channel_type' || errCode === 'is_private') {
      console.warn('[REVOKE] Private channel - bot must be manually invited: ' + channelId);
      throw new Error('Bot not in private channel. Run /invite @AccessReview in #channel first.');
    }

    // Unknown join error — fail closed (M3): do NOT blindly attempt a kick.
    console.error('[REVOKE] Join failed for ' + channelId + ': ' + errCode);
    throw new Error('Bot could not join channel (' + errCode + ')');
  }
}

module.exports = { revokeUserAccess };
