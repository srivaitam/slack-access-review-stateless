const { revokeUserAccess } = require('../services/revocationService');
const { buildRevocationConfirmModal } = require('../modals/revocationConfirmModal');
const { slack } = require('../slack/client');
const { isWorkspaceAdmin } = require('../utils/authz');
const { logAuditEvent } = require('../services/auditService');
const { generateAccessSnapshot, invalidateSnapshotCache } = require('../services/accessService');
const { generateMembershipCSV } = require('../services/exportService');
const { saveInternalDomains } = require('../services/settingsService');
const { createCampaign, recordDecision, recordDecisions, getCampaign } = require('../services/campaignService');
const { sendReviewChecklists, markDecisionInMessage, notifyCampaignComplete } = require('../services/reviewDelegationService');
const { buildReviewRosterView } = require('../views/reviewHomeView');
const { buildRevokeAccessModal } = require('../modals/revokeAccessModal');
const { getWorkspacePlan } = require('../services/planService');
const crypto = require('crypto');

// F-008: shown when someone reaches a revoke submission on a plan that can't revoke.
function planBlockedView() {
  return {
    response_action: 'update',
    view: {
      type: 'modal',
      title: { type: 'plain_text', text: 'Revocation unavailable' },
      close: { type: 'plain_text', text: 'Close' },
      blocks: [{
        type: 'section',
        text: { type: 'mrkdwn', text: '🔒 *Revocation requires Business+ or Enterprise Grid.*\n\nOn Free/Pro, Slack restricts removing members from channels, so this action is disabled here. Your current plan is shown on the dashboard.' }
      }]
    }
  };
}

// Reliably DM a user: open the IM channel first, then post. Posting to a raw
// user id (channel: 'Uxxxx') can silently fail depending on install state,
// which shows up as "nothing happens". Opening the conversation is reliable.
async function dmUser(userId, message) {
  try {
    const dm = await slack.conversations.open({ users: userId });
    await slack.chat.postMessage({ channel: dm.channel.id, ...message });
  } catch (e) {
    console.error('[DM] failed to message ' + userId + ':', e.message);
  }
}

async function handleViewSubmission(payload) {
  const callbackId = payload.view.callback_id;
  const adminId = payload.user.id;

  // Authorization (C3): revocation flows require a workspace owner/admin,
  // re-checked server-side on every submission — never trust the UI gate alone.
  // Campaign creation (F-003) is admin-only too.
  if (callbackId === 'user_access_modal' || callbackId === 'confirm_revocation' || callbackId === 'campaign_create_modal' || callbackId === 'channel_audit_export_modal' || callbackId === 'revoke_access_modal' || callbackId === 'domain_settings_modal') {
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

  // F-009: save internal domains — ticked from the list + any free-text extras
  // (admin-only, gated above). Unticked domains are treated as external.
  if (callbackId === 'domain_settings_modal') {
    const v = payload.view.state.values;
    const selected = (v.domains_select?.domains_multi?.selected_options || []).map(o => String(o.value).toLowerCase());
    const raw = v.domains_extra?.domains_input?.value || '';
    const extra = raw.split(',').map(d => d.trim().toLowerCase()).filter(Boolean);
    const domains = [...new Set([...selected, ...extra])];
    const domainRe = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
    const invalid = domains.filter(d => !domainRe.test(d));
    if (invalid.length) {
      return { response_action: 'errors', errors: { domains_extra: `Not a valid domain: ${invalid.join(', ')}. Use e.g. vaitam.com` } };
    }
    await saveInternalDomains(domains);
    invalidateSnapshotCache();
    setImmediate(() => dmUser(adminId, {
      text: domains.length
        ? `✅ Internal domains set to *${domains.join(', ')}*. Everyone else is external. Open Access Review → *Refresh* to recompute.`
        : '✅ Cleared — the app will auto-detect the most common domain again. Open Access Review → *Refresh* to recompute.'
    }));
    return { response_action: 'clear' };
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

  // F-001b: channel audit CSV for a chosen set of channels (admin-only, gated above).
  if (callbackId === 'channel_audit_export_modal') {
    const v = payload.view.state.values;
    const exportAll = (v.audit_all?.all?.selected_options?.length || 0) > 0;
    const selected = v.audit_channels?.audit_channels_select?.selected_conversations || [];
    if (!exportAll && selected.length === 0) {
      return { response_action: 'errors', errors: { audit_channels: 'Pick channels, or tick "Export ALL scanned channels" above.' } };
    }
    // Snapshot + CSV build can exceed the 3s modal window — do it in the background.
    setImmediate(async () => {
      try {
        const dm = await slack.conversations.open({ users: adminId });
        const dmChannelId = dm.channel.id;
        await slack.chat.postMessage({ channel: dmChannelId, text: exportAll ? '⏳ Generating channel audit CSV for all channels…' : `⏳ Generating channel audit CSV for ${selected.length} selected channel(s)…` });
        const { csv, metadata } = await generateMembershipCSV(exportAll ? {} : { channelIds: selected });
        const timestamp = new Date().toISOString().slice(0, 10);
        const skipped = exportAll ? 0 : (selected.length - metadata.exportedChannels);
        await slack.filesUploadV2({
          channel_id: dmChannelId,
          file: Buffer.from(csv, 'utf-8'),
          filename: `channel-audit-${timestamp}.csv`,
          title: `Channel Audit Export - ${timestamp}`,
          initial_comment: `📥 *Channel Audit CSV*\n📢 ${metadata.exportedChannels} channel(s) · 🔗 ${metadata.totalMemberships} membership row(s)` +
            (skipped > 0 ? `\n⚠️ ${skipped} selected channel(s) skipped — not scanned by the app (archived, or the bot isn't a member).` : '') +
            `\n_One row per channel × member — sort by Channel to certify a channel, by Email to certify a person._`
        });
      } catch (e) {
        console.error('[EXPORT] channel audit failed:', e.message);
        slack.chat.postMessage({ channel: adminId, text: '❌ Channel audit export failed. Please try again.' }).catch(() => {});
      }
    });
    return { response_action: 'clear' };
  }

  // F-007: multi-channel revoke from the dedicated modal (admin-only, gated above).
  if (callbackId === 'revoke_access_modal') {
    const plan = await getWorkspacePlan().catch(() => ({}));
    if (!plan.canRevoke) return planBlockedView();
    const v = payload.view.state.values;
    let revMeta = {};
    try { revMeta = JSON.parse(payload.view.private_metadata || '{}'); } catch (e) { /* no metadata */ }
    const targetUserId = revMeta.userId || v.revoke_user?.revoke_user_select?.selected_user;
    const channelIds = (v.revoke_channels?.channels?.selected_options || []).map(o => o.value);
    const reason = (v.revoke_reason?.reason?.value || '').trim();
    const notifyUser = (v.revoke_notify?.notify?.selected_options?.length || 0) > 0;

    const errors = {};
    if (!targetUserId) errors.revoke_reason = 'Pick a user at the top first — their channels will load.';
    else if (channelIds.length === 0) errors.revoke_channels = 'Select at least one channel.';
    if (reason.length < 10) errors.revoke_reason = 'Please give a reason of at least 10 characters.';
    if (Object.keys(errors).length > 0) return { response_action: 'errors', errors };

    const adminInfo = await slack.users.info({ user: adminId });
    const revokedBy = {
      id: adminId,
      name: adminInfo.user.profile.real_name || adminInfo.user.name,
      email: adminInfo.user.profile.email || 'unknown'
    };

    let target = { name: targetUserId, email: 'unknown' };
    try {
      const t = await slack.users.info({ user: targetUserId });
      target = { name: t.user.profile.real_name || t.user.name, email: t.user.profile.email || 'unknown' };
    } catch (e) { /* fall back to the id */ }

    const idempotencyKey = crypto.createHash('sha256')
      .update([adminId, targetUserId, [...channelIds].sort().join(','), reason].join('|'))
      .digest('hex');

    try {
      await logAuditEvent({
        action: 'ACCESS_REVOCATION_INITIATED',
        actor: revokedBy,
        target: { userId: targetUserId, userName: target.name, userEmail: target.email, channelIds },
        result: { channels: channelIds.length },
        reason,
        metadata: { idempotencyKey, via: 'multi_channel_modal' }
      });
    } catch (e) {
      console.error('[REVOKE] initiation audit failed:', e.message);
    }

    setImmediate(async () => {
      await dmUser(adminId, { text: `⏳ Revoking ${target.name} from ${channelIds.length} channel(s)…` });
      try {
        const results = await revokeUserAccess({
          userId: targetUserId, userName: target.name, userEmail: target.email,
          channelIds, reason, revokedBy, notifyUser, idempotencyKey
        });
        if (results.skipped) {
          await dmUser(adminId, { text: 'ℹ️ That revocation was already processed moments ago — no duplicate action taken.' });
          return;
        }
        const ok = results.successful.length;
        const bad = results.failed.length;
        const emoji = bad === 0 ? '✅' : (ok > 0 ? '⚠️' : '❌');
        const failDetail = bad > 0
          ? '\n*Failed (' + bad + '):*\n' + results.failed.map(f => '• <#' + f.channelId + '>: ' + f.error).join('\n')
          : '';
        await dmUser(adminId, {
          text: emoji + ' Revocation for ' + target.name + ': ' + ok + ' succeeded, ' + bad + ' failed.',
          blocks: [{
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: emoji + ' *Revocation ' + (bad === 0 ? 'complete' : 'partly complete') + '*\n\n' +
                '*User:* ' + target.name + '\n' +
                '*Removed from:* ' + ok + ' channel(s)\n' +
                (bad > 0 ? '*Failed:* ' + bad + ' channel(s)' + failDetail + '\n' : '') +
                '*Reason:* ' + reason + '\n' +
                '*Audit ID:* ' + (results.auditId || 'N/A')
            }
          }]
        });
      } catch (err) {
        console.error('[REVOKE] multi-channel background error:', err.message);
        await dmUser(adminId, { text: '❌ Revocation for ' + target.name + ' failed: ' + err.message });
      }
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
    const plan = await getWorkspacePlan().catch(() => ({}));
    if (!plan.canRevoke) return planBlockedView();
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

    // Fire in background AFTER responding. Always DM the admin so the action is
    // never silent: a progress note first, then a success/failure summary.
    setImmediate(async () => {
      await dmUser(adminId, { text: `⏳ Revoking ${metadata.userName} from ${metadata.channelIds.length} channel(s)…` });
      try {
        const results = await revokeUserAccess({
          userId: metadata.userId,
          userName: metadata.userName,
          userEmail: metadata.userEmail,
          channelIds: metadata.channelIds,
          reason: reason.trim(),
          revokedBy,
          notifyUser,
          idempotencyKey
        });

        if (results.skipped) {
          await dmUser(adminId, { text: 'ℹ️ That revocation was already processed moments ago — no duplicate action taken.' });
          return;
        }

        const successCount = results.successful.length;
        const failCount = results.failed.length;
        const statusEmoji = failCount === 0 ? '✅' : (successCount > 0 ? '⚠️' : '❌');
        const failDetail = failCount > 0
          ? '\n*Failed (' + failCount + '):*\n' + results.failed.map(f => '• <#' + f.channelId + '>: ' + f.error).join('\n')
          : '';

        await dmUser(adminId, {
          text: statusEmoji + ' Revocation for ' + metadata.userName + ': ' + successCount + ' succeeded, ' + failCount + ' failed.',
          blocks: [{
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: statusEmoji + ' *Revocation ' + (failCount === 0 ? 'complete' : 'partly complete') + '*\n\n' +
                '*User:* ' + metadata.userName + '\n' +
                '*Removed from:* ' + successCount + ' channel(s)\n' +
                (failCount > 0 ? '*Failed:* ' + failCount + ' channel(s)' + failDetail + '\n' : '') +
                '*Reason:* ' + reason.trim() + '\n' +
                '*Audit ID:* ' + (results.auditId || 'N/A')
            }
          }]
        });
      } catch (err) {
        console.error('[REVOKE] Background error:', err.message);
        await dmUser(adminId, { text: '❌ Revocation failed for ' + metadata.userName + ': ' + err.message });
      }
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
