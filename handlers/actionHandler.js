const { slack } = require('../slack/client');
const { generateAccessSnapshot } = require('../services/accessService');
const { buildAccessOverviewView } = require('../views/usersAccessView');
const { buildUserAccessModal } = require('../modals/userAccessModal');
const { buildRevokeAccessModal } = require('../modals/revokeAccessModal');
const { buildLoadingView } = require('../views/loadingView');
const { generateCSV, generateExcelXML } = require('../services/exportService');
const { isWorkspaceAdmin } = require('../utils/authz');
const { getInternalDomains } = require('../services/riskScoringService');
const { buildChannelBrowserModal, buildChannelMembersModal, buildChannelAuditExportModal } = require('../views/channelBrowserModal');
const { buildCampaignCreateModal } = require('../views/campaignModal');
const { recordDecision, recordDecisions, getCampaign, listCampaigns } = require('../services/campaignService');
const { markDecisionInMessage, notifyCampaignComplete } = require('../services/reviewDelegationService');
const { buildReviewIndexView, buildReviewRosterView, buildBulkJustificationModal, filterRoster, isException } = require('../views/reviewHomeView');

async function handleAction(payload) {
  const userId = payload.user.id;
  let action = payload.actions[0].action_id;

  // Export overflow menu: dispatch to the underlying export action.
  if (action === 'export_menu') {
    action = payload.actions[0].selected_option?.value;
    if (!action) return;
  }

  // F-004/F-005: reviewer decisions are NOT admin-only (channel owners review
  // their own channels) — campaignService enforces assigned-reviewer identity.
  if (action === 'review_decision') {
    return handleReviewDecision(payload);
  }

  // F-006: App Home review flow. Not admin-only — assigned reviewers act on
  // their own channels; handleReviewHome re-checks reviewer/admin per channel.
  if (action.startsWith('rev_')) {
    return handleReviewHome(payload);
  }

  // Authorization (C3/M6): actions that expose or act on the whole workspace
  // require an owner/admin. (view_user_detail keeps its own inline modal check.)
  const ADMIN_ONLY = new Set([
    'refresh_access_data', 'export_csv', 'export_excel',
    'export_membership_csv', 'browse_channels', 'channel_browser_select', 'create_campaign',
    'open_revoke_modal', 'sort_users', 'toggle_deactivated'
  ]);
  if (ADMIN_ONLY.has(action) && !(await isWorkspaceAdmin(userId))) {
    await slack.chat.postMessage({
      channel: userId,
      text: '🚫 *Access Denied* — only workspace Owners and Admins can use this action.'
    }).catch(() => {});
    return;
  }

  try {
    // ─── Refresh dashboard ───
    if (action === 'refresh_access_data') {
      await slack.views.publish({
        user_id: userId,
        view: buildLoadingView('Refreshing access data from Slack...')
      });
      const snapshot = await generateAccessSnapshot({ force: true });
      const campaigns = await listCampaigns({ activeOnly: true }).catch(() => []);
      await slack.views.publish({
        user_id: userId,
        view: buildAccessOverviewView(snapshot, 'riskScore', campaigns)
      });
    }

    // ─── Sort selector on home tab ───
    if (action === 'sort_users') {
      const sortBy = payload.actions[0].selected_option?.value || 'riskScore';
      const snapshot = await generateAccessSnapshot();
      const campaigns = await listCampaigns({ activeOnly: true }).catch(() => []);
      await slack.views.publish({
        user_id: userId,
        view: buildAccessOverviewView(snapshot, sortBy, campaigns)
      });
    }

    // ─── Show/hide deactivated members on home tab ───
    if (action === 'toggle_deactivated') {
      let state = { show: true, sortBy: 'riskScore' };
      try { state = JSON.parse(payload.actions[0].value); } catch (e) { /* defaults */ }
      const snapshot = await generateAccessSnapshot();
      const campaigns = await listCampaigns({ activeOnly: true }).catch(() => []);
      await slack.views.publish({
        user_id: userId,
        view: buildAccessOverviewView(snapshot, state.sortBy, campaigns, { showDeactivated: state.show })
      });
    }

    // ─── F-001/F-001b: channel-wise membership export — pick channels first ───
    if (action === 'export_membership_csv') {
      await slack.views.open({ trigger_id: payload.trigger_id, view: buildChannelAuditExportModal() });
    }

    // ─── F-002: channel browser ───
    if (action === 'browse_channels') {
      await slack.views.open({ trigger_id: payload.trigger_id, view: buildChannelBrowserModal() });
    }

    if (action === 'channel_browser_select') {
      const channelId = payload.actions[0].selected_conversation;
      const snapshot = await generateAccessSnapshot();
      const entry = snapshot.channels.find(c => c.channel.id === channelId);
      const viewId = payload.container?.view_id || payload.view?.id;
      if (!entry) {
        await slack.views.update({
          view_id: viewId,
          view: {
            type: 'modal',
            callback_id: 'channel_browser_modal',
            title: { type: 'plain_text', text: 'Channel Audit' },
            close: { type: 'plain_text', text: 'Close' },
            blocks: buildChannelBrowserModal().blocks.concat([
              { type: 'section', text: { type: 'mrkdwn', text: '⚠️ That conversation is not in the current access snapshot (it may be archived, a DM, or not yet scanned). Try *Refresh* on the dashboard first.' } }
            ])
          }
        });
      } else {
        await slack.views.update({
          view_id: viewId,
          view: buildChannelMembersModal(entry, getInternalDomains(snapshot.users))
        });
      }
    }

    // ─── F-003: create review campaign ───
    if (action === 'create_campaign') {
      await slack.views.open({ trigger_id: payload.trigger_id, view: buildCampaignCreateModal() });
    }

    // ─── F-007: multi-channel revoke — open the picker modal ───
    if (action === 'open_revoke_modal') {
      await slack.views.open({ trigger_id: payload.trigger_id, view: buildRevokeAccessModal() });
    }

    // ─── Export CSV ───
    if (action === 'export_csv') {
      // Open DM to get a valid channel_id (user IDs don't work with filesUploadV2)
      const dm = await slack.conversations.open({ users: userId });
      const dmChannelId = dm.channel.id;

      await slack.chat.postMessage({
        channel: dmChannelId,
        text: '⏳ Generating CSV export...'
      });

      const { csv, metadata } = await generateCSV();
      const timestamp = new Date().toISOString().slice(0, 10);

      await slack.filesUploadV2({
        channel_id: dmChannelId,
        file: Buffer.from(csv, 'utf-8'),
        filename: `access-review-${timestamp}.csv`,
        title: `Access Review Export - ${timestamp}`,
        initial_comment: `📥 *CSV Export Complete*\n👥 ${metadata.totalUsers} users | 📢 ${metadata.totalChannels} channels`
      });
    }

    // ─── Export Excel ───
    if (action === 'export_excel') {
      const dm = await slack.conversations.open({ users: userId });
      const dmChannelId = dm.channel.id;

      await slack.chat.postMessage({
        channel: dmChannelId,
        text: '⏳ Generating Excel export...'
      });

      const data = await generateExcelXML();
      const timestamp = new Date().toISOString().slice(0, 10);
      const xmlContent = buildExcelXml(data);

      await slack.filesUploadV2({
        channel_id: dmChannelId,
        file: Buffer.from(xmlContent, 'utf-8'),
        filename: `access-review-${timestamp}.xml`,
        title: `Access Review Export - ${timestamp}`,
        initial_comment: `📊 *Excel Export Complete*\n👥 ${data.metadata.totalUsers} users | 📢 ${data.metadata.totalChannels} channels\n_Contains 3 sheets: Users, Channels & Memberships (one row per channel × member)_`
      });
    }

    // ─── Open user access detail modal ───
    if (action === 'view_user_detail') {
      const targetUserId = payload.actions[0].value;

      const adminInfo = await slack.users.info({ user: userId });
      if (!adminInfo.user.is_owner && !adminInfo.user.is_admin) {
        await slack.views.open({
          trigger_id: payload.trigger_id,
          view: {
            type: 'modal',
            title: { type: 'plain_text', text: 'Access Denied' },
            close: { type: 'plain_text', text: 'Close' },
            blocks: [{
              type: 'section',
              text: { type: 'mrkdwn', text: '🚫 *Access Denied*\n\nOnly workspace Owners and Admins can view user access details and perform revocations.' }
            }]
          }
        });
        return;
      }

      const snapshot = await generateAccessSnapshot();
      const userAccess = snapshot.userAccessMap.get(targetUserId);

      if (userAccess) {
        await slack.views.open({
          trigger_id: payload.trigger_id,
          view: buildUserAccessModal(userAccess)
        });
      }
    }

    // ─── Ignore checkbox state changes ───
    if (action.startsWith('channel_checkbox_')) {
      return;
    }

  } catch (error) {
    console.error('Action error:', error.message);
    try {
      await slack.chat.postMessage({
        channel: userId,
        text: '❌ Something went wrong while processing that action. Please try again; if it keeps happening, contact your workspace admin.'
      });
    } catch (e) {
      // ignore
    }
  }
}

// ─── F-004/F-005: reviewer Keep/Remove/Flag decision from a DM checklist ───
// Overflow value format: "campaignId|channelId|userId|k" (k=keep, r=remove, f=flag)
async function handleReviewDecision(payload) {
  const userId = payload.user.id;
  try {
    const raw = payload.actions[0].selected_option?.value || '';
    const [campaignId, channelId, targetUserId, code] = raw.split('|');
    const decision = code === 'k' ? 'keep' : code === 'r' ? 'remove' : code === 'f' ? 'flag' : null;
    if (!campaignId || !channelId || !targetUserId || !decision) return;

    // Remove/Flag require a justification (F-005) — collect it in a modal.
    if (decision !== 'keep') {
      await slack.views.open({
        trigger_id: payload.trigger_id,
        view: {
          type: 'modal',
          callback_id: 'review_justification_modal',
          private_metadata: JSON.stringify({
            campaignId, channelId, targetUserId, decision,
            msgChannel: payload.container?.channel_id,
            msgTs: payload.message?.ts,
            blockId: `rev_${channelId}_${targetUserId}`
          }),
          title: { type: 'plain_text', text: decision === 'remove' ? 'Remove — justification' : 'Flag — justification' },
          submit: { type: 'plain_text', text: 'Record decision' },
          close: { type: 'plain_text', text: 'Cancel' },
          blocks: [{
            type: 'input',
            block_id: 'justification',
            label: { type: 'plain_text', text: 'Why? (recorded in the audit evidence)' },
            element: {
              type: 'plain_text_input',
              action_id: 'justification_input',
              multiline: true,
              min_length: 10,
              placeholder: { type: 'plain_text', text: 'e.g. Left the project in May; no longer needs access.' }
            }
          }]
        }
      });
      return;
    }

    // Keep: record immediately.
    const info = await slack.users.info({ user: userId });
    const reviewer = {
      id: userId,
      name: info.user.profile.real_name || info.user.name,
      email: info.user.profile.email || 'unknown'
    };
    const result = await recordDecision({
      campaignId, channelId, targetUserId, decision, reviewer,
      reviewerIsAdmin: Boolean(info.user.is_owner || info.user.is_admin)
    });

    if (!result.ok) {
      await slack.chat.postMessage({ channel: userId, text: `⚠️ Could not record decision: ${result.error}` }).catch(() => {});
      return;
    }

    if (payload.message?.ts && payload.container?.channel_id) {
      await markDecisionInMessage({
        channelOfMessage: payload.container.channel_id,
        messageTs: payload.message.ts,
        blocks: payload.message.blocks,
        blockId: `rev_${channelId}_${targetUserId}`,
        decision,
        reviewerName: reviewer.name
      }).catch(e => console.error('[REVIEW] block update failed:', e.message));
    }

    if (result.campaign.status === 'completed') {
      await notifyCampaignComplete(result.campaign);
    }
  } catch (error) {
    console.error('Review decision error:', error.message);
    await slack.chat.postMessage({ channel: userId, text: '❌ Something went wrong recording that decision. Please try again.' }).catch(() => {});
  }
}

// ─── F-006: App Home review flow (channel index + paginated roster) ─────────
function safeMeta(str) {
  try { return JSON.parse(str || '{}'); } catch (e) { return {}; }
}

function selectedUserIds(state) {
  const ids = [];
  if (!state || !state.values) return ids;
  Object.values(state.values).forEach(block => {
    Object.values(block).forEach(el => {
      if (el && el.type === 'checkboxes' && Array.isArray(el.selected_options)) {
        el.selected_options.forEach(o => ids.push(o.value));
      }
    });
  });
  return ids;
}

// Non-destructive error: DM the reviewer instead of clobbering their Home tab.
async function reviewNotice(userId, text) {
  await slack.chat.postMessage({ channel: userId, text }).catch(() => {});
}

async function maybeNotifyComplete(campaign) {
  if (campaign && campaign.status === 'completed') {
    await notifyCampaignComplete(campaign).catch(e => console.error('[REVIEW] completion notice failed:', e.message));
  }
}

async function publishRoster(userId, campaignId, channelId, isAdmin, { page = 0, pageSize, filter = 'todo' } = {}) {
  const campaign = await getCampaign(campaignId);
  if (!campaign) return reviewNotice(userId, '⚠️ That campaign could not be found — it may have closed.');
  const channel = campaign.channels.find(c => c.id === channelId);
  if (!channel) return reviewNotice(userId, '⚠️ That channel is not part of the campaign.');
  await slack.views.publish({
    user_id: userId,
    view: buildReviewRosterView({ campaign, channel, userId, isAdmin, page, pageSize, filter })
  });
}

async function handleReviewHome(payload) {
  const userId = payload.user.id;
  const act = payload.actions[0];
  const id = act.action_id;

  // Checkbox ticks carry state only — nothing to do until a bulk button fires.
  if (id.startsWith('rev_select_')) return;

  try {
    const info = await slack.users.info({ user: userId });
    const reviewer = {
      id: userId,
      name: info.user.profile.real_name || info.user.name,
      email: info.user.profile.email || 'unknown'
    };
    const isAdmin = Boolean(info.user.is_owner || info.user.is_admin);

    // Back to the workspace dashboard (admin-gated view).
    if (id === 'rev_back_dashboard') {
      if (!isAdmin) return reviewNotice(userId, '🔒 Only workspace Owners and Admins can open the access dashboard.');
      const snapshot = await generateAccessSnapshot();
      const campaigns = await listCampaigns({ activeOnly: true }).catch(() => []);
      await slack.views.publish({ user_id: userId, view: buildAccessOverviewView(snapshot, 'riskScore', campaigns) });
      return;
    }

    // Open a campaign's channel index. value = campaignId.
    if (id === 'rev_open_index') {
      const campaign = await getCampaign(act.value);
      if (!campaign) return reviewNotice(userId, '⚠️ That campaign could not be found — it may have closed.');
      await slack.views.publish({ user_id: userId, view: buildReviewIndexView({ campaign, userId, isAdmin }) });
      return;
    }

    // Channel-scoped actions. Context comes from the rev_open value or, for
    // roster nav, from the home view's private_metadata.
    let campaignId, channelId, page = 0, pageSize, filter = 'todo';
    if (id === 'rev_open') {
      [campaignId, channelId] = String(act.value).split('|');
    } else {
      const meta = safeMeta(payload.view && payload.view.private_metadata);
      campaignId = meta.c; channelId = meta.ch; page = meta.p || 0; pageSize = meta.ps; filter = meta.f || 'todo';
    }
    if (!campaignId || !channelId) return reviewNotice(userId, '⚠️ Lost track of that review. Reopen it from the dashboard.');

    const campaign = await getCampaign(campaignId);
    if (!campaign) return reviewNotice(userId, '⚠️ That campaign could not be found — it may have closed.');
    const channel = campaign.channels.find(c => c.id === channelId);
    if (!channel) return reviewNotice(userId, '⚠️ That channel is not part of the campaign.');

    // Authorization: assigned reviewer or workspace admin.
    if (channel.reviewerId !== userId && !isAdmin) {
      return reviewNotice(userId, '🚫 You are not the assigned reviewer for that channel.');
    }

    // Bulk decisions read the checkbox selection off the current view state.
    if (id === 'rev_bulk_keep' || id === 'rev_bulk_remove' || id === 'rev_bulk_flag') {
      const decision = id === 'rev_bulk_keep' ? 'keep' : id === 'rev_bulk_remove' ? 'remove' : 'flag';
      const selected = selectedUserIds(payload.view && payload.view.state);
      if (selected.length === 0) {
        return reviewNotice(userId, '☝️ Tick at least one member first, then choose Keep, Revoke, or Flag.');
      }
      if (decision !== 'keep') {
        // Collect one justification for the whole batch.
        await slack.views.open({
          trigger_id: payload.trigger_id,
          view: buildBulkJustificationModal({ campaignId, channelId, decision, userIds: selected, page, pageSize, filter })
        });
        return;
      }
      await recordDecisions({
        campaignId, channelId,
        decisions: selected.map(uid => ({ targetUserId: uid, decision: 'keep' })),
        reviewer, reviewerIsAdmin: isAdmin
      });
      const fresh = await getCampaign(campaignId);
      await maybeNotifyComplete(fresh);
      return publishRoster(userId, campaignId, channelId, isAdmin, { page, pageSize, filter });
    }

    // Keep-all-routine: bulk keep every undecided member with no risk flag.
    if (id === 'rev_keep_routine') {
      const routine = filterRoster(channel, 'todo').filter(m => !isException(m));
      if (routine.length) {
        await recordDecisions({
          campaignId, channelId,
          decisions: routine.map(m => ({ targetUserId: m.id, decision: 'keep' })),
          reviewer, reviewerIsAdmin: isAdmin
        });
        const fresh = await getCampaign(campaignId);
        await maybeNotifyComplete(fresh);
      }
      return publishRoster(userId, campaignId, channelId, isAdmin, { page: 0, pageSize, filter });
    }

    // Navigation.
    if (id === 'rev_page_prev') page = Math.max(0, (page || 0) - 1);
    else if (id === 'rev_page_next') page = (page || 0) + 1;
    else if (id.startsWith('rev_filter_')) { filter = act.value; page = 0; }
    else if (id === 'rev_pagesize') { pageSize = act.selected_option && act.selected_option.value; page = 0; }
    // rev_open falls through with defaults.

    await slack.views.publish({
      user_id: userId,
      view: buildReviewRosterView({ campaign, channel, userId, isAdmin, page, pageSize, filter })
    });
  } catch (error) {
    console.error('Review home error:', error.message);
    await reviewNotice(userId, '❌ Something went wrong. Reopen the review from the dashboard and try again.');
  }
}

/**
 * Build XML Spreadsheet 2003 format (.xls)
 */
function buildExcelXml(data) {
  function esc(str) {
    return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function sheet(name, headers, rows) {
    let s = `<Worksheet ss:Name="${esc(name)}"><Table>`;
    s += '<Row>';
    for (const h of headers) {
      s += `<Cell ss:StyleID="header"><Data ss:Type="String">${esc(h)}</Data></Cell>`;
    }
    s += '</Row>';
    for (const row of rows) {
      s += '<Row>';
      for (const cell of row) {
        const type = typeof cell === 'number' ? 'Number' : 'String';
        s += `<Cell><Data ss:Type="${type}">${esc(cell)}</Data></Cell>`;
      }
      s += '</Row>';
    }
    s += '</Table></Worksheet>';
    return s;
  }

  return '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<?mso-application progid="Excel.Sheet"?>\n' +
    '<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" ' +
    'xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">' +
    '<Styles><Style ss:ID="header"><Font ss:Bold="1"/><Interior ss:Color="#D9E1F2" ss:Pattern="Solid"/></Style></Styles>' +
    sheet('Users', data.users.headers, data.users.rows) +
    sheet('Channels', data.channels.headers, data.channels.rows) +
    (data.memberships ? sheet('Memberships', data.memberships.headers, data.memberships.rows) : '') + // F-001
    '</Workbook>';
}

module.exports = { handleAction };
