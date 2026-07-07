const { slack, getCurrentTeamId } = require('../slack/client');
const { getRiskEmoji } = require('./riskScoringService');
const { campaignProgress } = require('./campaignService');

// F-004: DM each channel's assigned reviewer a Keep/Remove/Flag checklist.
// Overflow option values must stay under Slack's 75-char cap, so we encode
// them as "campaignId|channelId|userId|k" (k=keep, r=remove, f=flag).

const MEMBERS_PER_MESSAGE = 40; // stay well under Slack's 50-block message cap

function memberFlags(m) {
  const flags = [];
  if (m.role === 'Guest') flags.push('👤 guest');
  if (m.role === 'Owner' || m.role === 'Admin') flags.push('🛡 ' + m.role.toLowerCase());
  if (!m.active) flags.push('🚫 deactivated');
  return flags.length ? ' · ' + flags.join(' · ') : '';
}

function decisionLabel(d) {
  return d === 'keep' ? '✅ Kept' : d === 'remove' ? '🗑 Marked for removal' : '🚩 Flagged';
}

function memberBlock(campaign, ch, m) {
  const decided = ch.decisions && ch.decisions[m.id];
  const base = `*${m.name}*  <mailto:${m.email}|${m.email}> · ${m.role}${memberFlags(m)}`;
  if (decided) {
    return {
      type: 'section',
      block_id: `rev_${ch.id}_${m.id}`,
      text: { type: 'mrkdwn', text: `${base}\n${decisionLabel(decided.decision)} — ${decided.reviewer.name}, ${decided.timestamp.slice(0, 16).replace('T', ' ')}` }
    };
  }
  const v = (d) => [campaign.id, ch.id, m.id, d].join('|');
  return {
    type: 'section',
    block_id: `rev_${ch.id}_${m.id}`,
    text: { type: 'mrkdwn', text: base },
    accessory: {
      type: 'overflow',
      action_id: 'review_decision',
      options: [
        { text: { type: 'plain_text', text: '✅ Keep' }, value: v('k') },
        { text: { type: 'plain_text', text: '🗑 Remove' }, value: v('r') },
        { text: { type: 'plain_text', text: '🚩 Flag' }, value: v('f') }
      ]
    }
  };
}

function checklistMessages(campaign, ch, queueButton) {
  const messages = [];
  for (let i = 0; i < ch.members.length; i += MEMBERS_PER_MESSAGE) {
    const chunk = ch.members.slice(i, i + MEMBERS_PER_MESSAGE);
    const part = ch.members.length > MEMBERS_PER_MESSAGE
      ? ` (part ${Math.floor(i / MEMBERS_PER_MESSAGE) + 1}/${Math.ceil(ch.members.length / MEMBERS_PER_MESSAGE)})`
      : '';

    const header = [{
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `📋 *Access review: <#${ch.id}>* ${getRiskEmoji(ch.riskScore)}${part}\n` +
          `Campaign *${campaign.name}* · due *${campaign.dueDate}*\n` +
          `You are the reviewer for this channel.`
      }
    }];

    // F-006: one-click into the paginated review queue (part 1 only).
    if (i === 0 && queueButton) {
      header.push({ type: 'actions', elements: [queueButton] });
      header.push({
        type: 'context',
        elements: [{ type: 'mrkdwn', text: '*Recommended:* opens your queue in the app Home tab — filter, paginate, and Keep/Remove/Flag in bulk. Or decide each member below from the ⋯ menu (Remove/Flag asks for a justification).' }]
      });
    } else {
      header.push({
        type: 'context',
        elements: [{ type: 'mrkdwn', text: 'For each member choose *Keep*, *Remove*, or *Flag* from the ⋯ menu. Remove/Flag will ask for a justification.' }]
      });
    }

    messages.push({
      text: `Access review: #${ch.name} — ${ch.members.length} member(s) to review`,
      blocks: [
        ...header,
        { type: 'divider' },
        ...chunk.map(m => memberBlock(campaign, ch, m))
      ]
    });
  }
  return messages;
}

// F-006: resolve the App Home deep link (cached per workspace). SLACK_APP_ID
// short-circuits the API lookup; otherwise derive the app id from the bot.
const _appMetaCache = new Map();
async function getAppMeta() {
  const key = getCurrentTeamId();
  if (_appMetaCache.has(key)) return _appMetaCache.get(key);
  const meta = { teamId: null, appId: process.env.SLACK_APP_ID || null };
  try {
    const auth = await slack.auth.test();
    meta.teamId = auth.team_id || null;
    if (!meta.appId && auth.bot_id) {
      const info = await slack.bots.info({ bot: auth.bot_id });
      meta.appId = (info.bot && info.bot.app_id) || null;
    }
  } catch (e) {
    console.error('[REVIEW] could not resolve app metadata for deep link:', e.message);
  }
  _appMetaCache.set(key, meta);
  return meta;
}

/**
 * Button that takes a reviewer straight to their queue. When team + app id are
 * known it deep-links to the Home tab (url); otherwise it falls back to a plain
 * action button that publishes the Home tab on click (the reviewer then opens
 * the Home tab themselves).
 */
async function reviewQueueButton(campaignId) {
  const { teamId, appId } = await getAppMeta();
  const button = {
    type: 'button',
    text: { type: 'plain_text', text: '📋 Open my review queue' },
    action_id: 'rev_open_index',
    value: campaignId,
    style: 'primary'
  };
  if (teamId && appId) button.url = `slack://app?team=${teamId}&id=${appId}&tab=home`;
  return button;
}

/**
 * Send checklists for every channel in the campaign. Groups channels by
 * reviewer, DMs each reviewer. Returns {sent, failed[]}.
 */
async function sendReviewChecklists(campaign) {
  let sent = 0;
  const failed = [];
  const queueButton = await reviewQueueButton(campaign.id);
  for (const ch of campaign.channels) {
    try {
      const dm = await slack.conversations.open({ users: ch.reviewerId });
      for (const msg of checklistMessages(campaign, ch, queueButton)) {
        await slack.chat.postMessage({ channel: dm.channel.id, ...msg });
      }
      sent++;
    } catch (e) {
      failed.push({ channel: ch.name, reviewerId: ch.reviewerId, error: e.data?.error || e.message });
    }
  }
  return { sent, failed };
}

/**
 * After a decision, rewrite that member's block in the original DM message
 * so the checklist shows live progress.
 */
async function markDecisionInMessage({ channelOfMessage, messageTs, blocks, blockId, decision, reviewerName }) {
  const updated = (blocks || []).map(b => {
    if (b.block_id !== blockId) return b;
    const baseText = (b.text?.text || '').split('\n')[0];
    return {
      type: 'section',
      block_id: b.block_id,
      text: { type: 'mrkdwn', text: `${baseText}\n${decisionLabel(decision)} — ${reviewerName}` }
    };
  });
  await slack.chat.update({ channel: channelOfMessage, ts: messageTs, text: 'Access review checklist', blocks: updated });
}

/** Notify the campaign creator when a campaign auto-completes. */
async function notifyCampaignComplete(campaign) {
  const p = campaignProgress(campaign);
  try {
    const dm = await slack.conversations.open({ users: campaign.createdBy.id });
    await slack.chat.postMessage({
      channel: dm.channel.id,
      text: `Campaign "${campaign.name}" is complete.`,
      blocks: [{
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `🎉 *Campaign complete: ${campaign.name}*\n` +
            `${p.decided}/${p.total} memberships reviewed · 🗑 ${p.removals} marked for removal · 🚩 ${p.flags} flagged\n` +
            `Every decision is recorded in the tamper-evident audit log. Use the flagged/removal lists to run revocations from the dashboard.`
        }
      }]
    });
  } catch (e) {
    console.error('[CAMPAIGN] completion notice failed:', e.message);
  }
}

module.exports = { sendReviewChecklists, markDecisionInMessage, notifyCampaignComplete, checklistMessages, reviewQueueButton };
