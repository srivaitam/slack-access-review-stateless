const { revokeUserAccess } = require('../services/revocationService');
const { buildRevocationConfirmModal } = require('../modals/revocationConfirmModal');
const { slack } = require('../slack/client');
const { isWorkspaceAdmin } = require('../utils/authz');
const { logAuditEvent } = require('../services/auditService');
const crypto = require('crypto');

async function handleViewSubmission(payload) {
  const callbackId = payload.view.callback_id;
  const adminId = payload.user.id;

  // Authorization (C3): revocation flows require a workspace owner/admin,
  // re-checked server-side on every submission — never trust the UI gate alone.
  if (callbackId === 'user_access_modal' || callbackId === 'confirm_revocation') {
    if (!(await isWorkspaceAdmin(adminId))) {
      return {
        response_action: 'update',
        view: {
          type: 'modal',
          title: { type: 'plain_text', text: 'Access Denied' },
          close: { type: 'plain_text', text: 'Close' },
          blocks: [{
            type: 'section',
            text: { type: 'mrkdwn', text: '🚫 *Access Denied*\n\nOnly workspace Owners and Admins can revoke access.' }
          }]
        }
      };
    }
  }

  // Step 1: Revoke Selected clicked
  if (callbackId === 'user_access_modal') {
    const metadata = JSON.parse(payload.view.private_metadata);
    const stateValues = payload.view.state.values;

    const selectedChannelIds = [];
    Object.values(stateValues).forEach(block => {
      Object.values(block).forEach(action => {
        if (action.type === 'checkboxes' && action.selected_options) {
          action.selected_options.forEach(opt => selectedChannelIds.push(opt.value));
        }
      });
    });

    if (selectedChannelIds.length === 0) {
      return {
        response_action: 'errors',
        errors: { channel_select_0: 'Please select at least one channel to revoke.' }
      };
    }

    const allChannels = metadata.channels || [];
    const channelsToRevoke = allChannels.filter(ch => selectedChannelIds.includes(ch.id));

    if (channelsToRevoke.length === 0) {
      return {
        response_action: 'errors',
        errors: { channel_select_0: 'Could not find selected channels. Please close and try again.' }
      };
    }

    return {
      response_action: 'push',
      view: buildRevocationConfirmModal(
        metadata.userId,
        metadata.userName,
        metadata.userEmail,
        channelsToRevoke
      )
    };
  }

  // Step 2: Admin confirmed
  if (callbackId === 'confirm_revocation') {
    const metadata = JSON.parse(payload.view.private_metadata);
    const values = payload.view.state.values;
    const reason = values.revocation_reason?.reason_input?.value || '';
    const notifyUser = values.notify_user_option?.notify_checkbox?.selected_options?.length > 0;

    if (!reason || reason.trim().length < 10) {
      return {
        response_action: 'errors',
        errors: { revocation_reason: 'Please provide a reason of at least 10 characters.' }
      };
    }

    const adminInfo = await slack.users.info({ user: adminId });
    const revokedBy = {
      id: adminId,
      name: adminInfo.user.profile.real_name || adminInfo.user.name,
      email: adminInfo.user.profile.email || 'unknown'
    };

    // Deterministic idempotency key for this exact revocation (H7)
    const idempotencyKey = crypto
      .createHash('sha256')
      .update([adminId, metadata.userId, [...metadata.channelIds].sort().join(','), reason.trim()].join('|'))
      .digest('hex');

    // Record intent BEFORE the async work so there's a durable trail even if
    // the process restarts mid-revocation (H7).
    try {
      await logAuditEvent({
        action: 'ACCESS_REVOCATION_INITIATED',
        actor: revokedBy,
        target: { userId: metadata.userId, userName: metadata.userName, userEmail: metadata.userEmail, channelIds: metadata.channelIds },
        result: { channels: metadata.channelIds.length },
        reason: reason.trim(),
        metadata: { idempotencyKey }
      });
    } catch (e) {
      console.error('[REVOKE] initiation audit failed:', e.message);
    }

    // Fire in background AFTER responding
    setImmediate(() => {
      revokeUserAccess({
        userId: metadata.userId,
        userName: metadata.userName,
        userEmail: metadata.userEmail,
        channelIds: metadata.channelIds,
        reason: reason.trim(),
        revokedBy,
        notifyUser,
        idempotencyKey
      }).then(results => {
        if (results.skipped) {
          slack.chat.postMessage({
            channel: adminId,
            text: 'ℹ️ That revocation was already processed moments ago — no duplicate action taken.'
          }).catch(() => {});
          return;
        }
        const successCount = results.successful.length;
        const failCount = results.failed.length;
        const statusEmoji = failCount === 0 ? '✅' : (successCount > 0 ? '⚠️' : '❌');

        // Build failure detail if any
        let failDetail = '';
        if (failCount > 0) {
          failDetail = '\n*Failed (' + failCount + '):*\n' +
            results.failed.map(f => '• ' + f.channelId + ': ' + f.error).join('\n');
        }

        const summaryText = statusEmoji + ' Revocation for ' + metadata.userName + ': ' +
          successCount + ' succeeded, ' + failCount + ' failed.';

        slack.chat.postMessage({
          channel: adminId,
          text: summaryText,
          blocks: [
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: statusEmoji + ' *Revocation Complete*\n\n' +
                  '*User:* ' + metadata.userName + '\n' +
                  '*Removed from:* ' + successCount + ' channel(s)\n' +
                  (failCount > 0 ? '*Failed:* ' + failCount + ' channel(s)' + failDetail + '\n' : '') +
                  '*Reason:* ' + reason.trim() + '\n' +
                  '*Audit ID:* ' + (results.auditId || 'N/A')
              }
            }
          ]
        }).catch(e => console.error('[DM] Error:', e.message));

      }).catch(err => {
        console.error('[REVOKE] Background error:', err.message);
        slack.chat.postMessage({
          channel: adminId,
          text: '❌ Revocation failed for ' + metadata.userName + ': ' + err.message
        }).catch(() => {});
      });
    });

    return { response_action: 'clear' };
  }

  return null;
}

module.exports = { handleViewSubmission };
