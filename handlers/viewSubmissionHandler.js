const { revokeUserAccess } = require('../services/revocationService');
const { buildRevocationConfirmModal } = require('../modals/revocationConfirmModal');
const { slack } = require('../slack/client');
const { isWorkspaceAdmin } = require('../utils/authz');
const { logAuditEvent } = require('../services/auditService');
const { generateAccessSnapshot } = require('../services/accessService');
const { createCampaign, recordDecision, recordDecisions, getCampaign } = require('../services/campaignService');
const { sendReviewChecklists, markDecisionInMessage, notifyCampaignComplete } = require('../services/reviewDelegationService');
const { buildReviewRosterView } = require('../views/reviewHomeView');
const crypto = require('crypto');

async function handleViewSubmission(payload) {
  const callbackId = payload.view.callback_id;
  const adminId = payload.user.id;

  // Authorization (C3): revocation flows require a workspace owner/admin,
  // re-checked server-side on every submission — never trust the UI gate alone.
  // Campaign creation (F-003) is admin-only too.
  if (callbackId === 'user_access_modal' || callbackId === 'confirm_revocation' || callbackId === 'campaign_create_modal') {
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

  // F-003: launch a review campaign
  if (callbackId === 'campaign_create_modal') {
    const v = payload.view.state.values;
    const name = v.campaign_name?.name_input?.value?.trim();
    const scope = v.campaign_scope?.scope_select?.selected_option?.value;
    const dueDate = v.campaign_due?.due_date?.selected_date;
    const recurrence = v.campaign_recurrence?.recurrence_select?.selected_option?.value || 'none';

    if (!name || name.length < 3) {
      return { response_action: 'errors', errors: { campaign_name: 'Please give the campaign a name (3+ characters).' } };
    }
    if (!dueDate || dueDate < new Date().toISOString().slice(0, 10)) {
      return { response_action: 'errors', errors: { campaign_due: 'Due date must be today or later.' } };
    }

    const adminInfo = await slack.users.info({ user: adminId });
    const createdBy = {
      id: adminId,
      name: adminInfo.user.profile.real_name || adminInfo.user.name,
      email: adminInfo.user.profile.email || 'unknown'
    };

    // Launch in background — snapshot + checklist fan-out can exceed the
    // 3-second modal window.
    setImmediate(() => {
      launchCampaign({ name, scope, dueDate, recurrence, createdBy })
        .catch(err => {
          console.error('[CAMPAIGN] launch failed:', err.message);
          slack.chat.postMessage({ channel: adminId, text: `❌ Campaign "${name}" failed to launch: ${err.message}` }).catch(() => {});
        });
    });

    return { response_action: 'clear' };
  }

  // F-005: justification for a Remove/Flag decision
  if (callbackId === 'review_justification_modal') {
    const meta = JSON.parse(payload.view.private_metadata);
    const justification = payload.view.state.values.justification?.justification_input?.value?.trim();
    if (!justification || justification.length < 10) {
      return { response_action: 'errors', errors: { justification: 'Please provide a justification of at least 10 characters.' } };
    }

    const info = await slack.users.info({ user: adminId });
    const reviewer = {
      id: adminId,
      name: info.user.profile.real_name || info.user.name,
      email: info.user.profile.email || 'unknown'
    };

    const result = await recordDecision({
      campaignId: meta.campaignId,
      channelId: meta.channelId,
      targetUserId: meta.targetUserId,
      decision: meta.decision,
      reviewer,
      justification,
      reviewerIsAdmin: Boolean(info.user.is_owner || info.user.is_admin)
    });

    if (!result.ok) {
      return { response_action: 'errors', errors: { justification: 'Could not record: ' + result.error } };
    }

    // Update the checklist DM in the background (needs a message fetch).
    setImmediate(async () => {
      try {
        if (meta.msgChannel && meta.msgTs) {
          const hist = await slack.conversations.history({ channel: meta.msgChannel, latest: meta.msgTs, inclusive: true, limit: 1 });
          const msg = hist.messages && hist.messages[0];
          if (msg && msg.ts === meta.msgTs) {
            await markDecisionInMessage({
              channelOfMessage: meta.msgChannel,
              messageTs: meta.msgTs,
              blocks: msg.blocks,
              blockId: meta.blockId,
              decision: meta.decision,
              reviewerName: reviewer.name
            });
          }
        }
        if (result.campaign.status === 'completed') await notifyCampaignComplete(result.campaign);
      } catch (e) {
        console.error('[REVIEW] post-decision update failed:', e.message);
      }
    });

    return { response_action: 'clear' };
  }

  // F-006: one justification applied to a batch of Remove/Flag decisions made
  // from the App Home roster. Republishes the roster where the reviewer left off.
  if (callbackId === 'review_bulk_justification_modal') {
    const meta = JSON.parse(payload.view.private_metadata);
    const justification = payload.view.state.values.justification?.justification_input?.value?.trim();
    if (!justification || justification.length < 10) {
      return { response_action: 'errors', errors: { justification: 'Please provide a justification of at least 10 characters.' } };
    }

    const info = await slack.users.info({ user: adminId });
    const reviewer = {
      id: adminId,
      name: info.user.profile.real_name || info.user.name,
      email: info.user.profile.email || 'unknown'
    };
    const reviewerIsAdmin = Boolean(info.user.is_owner || info.user.is_admin);

    const result = await recordDecisions({
      campaignId: meta.campaignId,
      channelId: meta.channelId,
      decisions: (meta.userIds || []).map(uid => ({ targetUserId: uid, decision: meta.decision, justification })),
      reviewer,
      reviewerIsAdmin
    });

    if (!result.ok) {
      return { response_action: 'errors', errors: { justification: 'Could not record: ' + result.error } };
    }

    // Republish the roster (and send completion notice) in the background.
    setImmediate(async () => {
      try {
        const fresh = await getCampaign(meta.campaignId);
        const freshCh = fresh && fresh.channels.find(c => c.id === meta.channelId);
        if (freshCh) {
          await slack.views.publish({
            user_id: adminId,
            view: buildReviewRosterView({
              campaign: fresh, channel: freshCh, userId: adminId, isAdmin: reviewerIsAdmin,
              page: meta.page, pageSize: meta.pageSize, filter: meta.filter
            })
          });
        }
        if (fresh && fresh.status === 'completed') await notifyCampaignComplete(fresh);
      } catch (e) {
        console.error('[REVIEW] bulk republish failed:', e.message);
      }
    });

    return { response_action: 'clear' };
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

// F-003/F-004: snapshot → campaign → DM checklists → confirm to creator.
async function launchCampaign({ name, scope, dueDate, recurrence, createdBy }) {
  const snapshot = await generateAccessSnapshot();
  const campaign = await createCampaign({ name, scope, dueDate, recurrence, createdBy, snapshot });

  if (campaign.channels.length === 0) {
    await slack.chat.postMessage({
      channel: createdBy.id,
      text: `⚠️ Campaign "${name}" launched but matched 0 channels for scope "${scope}". Nothing to review.`
    });
    return campaign;
  }

  const { sent, failed } = await sendReviewChecklists(campaign);
  const totalMembers = campaign.channels.reduce((s, c) => s + c.members.length, 0);

  let failText = '';
  if (failed.length) {
    failText = `\n⚠️ Could not reach ${failed.length} reviewer(s): ` +
      failed.slice(0, 5).map(f => `#${f.channel}`).join(', ') +
      (failed.length > 5 ? '…' : '') + ' — review those channels from the dashboard.';
  }

  await slack.chat.postMessage({
    channel: createdBy.id,
    text: `Campaign "${name}" launched.`,
    blocks: [{
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `🚀 *Campaign launched: ${name}*\n` +
          `Scope: ${scope} · Due: ${dueDate} · Recurrence: ${recurrence}\n` +
          `📢 ${campaign.channels.length} channel(s) · 🔗 ${totalMembers} membership(s) to review\n` +
          `✉️ Checklists sent to ${sent} reviewer(s).${failText}\n` +
          `_Campaign ID: ${campaign.id} — progress is visible on the dashboard._`
      }
    }]
  });
  return campaign;
}

module.exports = { handleViewSubmission, launchCampaign };
