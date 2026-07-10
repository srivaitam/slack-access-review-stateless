// F-017: recurring review reminders + escalation. Run daily (see index.js).
// For each active campaign, DM reviewers who still have pending channels once
// the due date is near or passed; when overdue, escalate to the campaign creator.
const { slack } = require('../slack/client');
const { reviewQueueButton } = require('./reviewDelegationService');
const { getRiskEmoji } = require('./riskScoringService');

// Pure: reviewer id -> [{ name, remaining, riskScore }] for channels with
// undecided members.
function pendingByReviewer(campaign) {
  const byReviewer = {};
  for (const ch of campaign.channels || []) {
    let remaining = 0;
    for (const m of ch.members || []) if (!(ch.decisions && ch.decisions[m.id])) remaining++;
    if (remaining > 0) {
      (byReviewer[ch.reviewerId] = byReviewer[ch.reviewerId] || []).push({ name: ch.name, remaining, riskScore: ch.riskScore || 0 });
    }
  }
  return byReviewer;
}

// Pure: should we remind now? Only within `leadDays` of the due date, or overdue.
function reminderDue(campaign, leadDays, today = new Date().toISOString().slice(0, 10)) {
  if (campaign.status !== 'active') return { due: false, overdue: false };
  const dd = campaign.dueDate;
  if (!dd) return { due: true, overdue: false };
  const overdue = dd < today;
  const days = Math.ceil((new Date(dd + 'T00:00:00Z') - new Date(today + 'T00:00:00Z')) / 86400000);
  return { due: overdue || days <= leadDays, overdue };
}

async function sendReviewReminders(campaign, opts = {}) {
  const leadDays = opts.leadDays != null ? opts.leadDays : Number(process.env.REVIEW_REMINDER_LEAD_DAYS || 3);
  const { due, overdue } = reminderDue(campaign, leadDays);
  if (!due) return { reminded: 0, escalated: false };

  const byReviewer = pendingByReviewer(campaign);
  const queueBtn = await reviewQueueButton(campaign.id).catch(() => null);
  let reminded = 0;
  for (const [reviewerId, chans] of Object.entries(byReviewer)) {
    try {
      const dm = await slack.conversations.open({ users: reviewerId });
      await slack.chat.postMessage({
        channel: dm.channel.id,
        text: `Reminder: ${chans.length} channel(s) still need your review`,
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `⏰ *Access review reminder — ${campaign.name}*\n${overdue ? '*Overdue* — ' : ''}due *${campaign.dueDate}*. You have *${chans.length}* channel(s) with pending decisions:\n` +
                chans.slice(0, 10).map(c => `• ${getRiskEmoji(c.riskScore)} #${c.name} — ${c.remaining} left`).join('\n')
            }
          },
          ...(queueBtn ? [{ type: 'actions', elements: [queueBtn] }] : [])
        ]
      });
      reminded++;
    } catch (e) {
      console.error('[REMINDER] DM failed for', reviewerId, e.message);
    }
  }

  let escalated = false;
  if (overdue && campaign.createdBy && campaign.createdBy.id) {
    try {
      const dm = await slack.conversations.open({ users: campaign.createdBy.id });
      await slack.chat.postMessage({
        channel: dm.channel.id,
        text: `Campaign overdue: ${campaign.name}`,
        blocks: [{
          type: 'section',
          text: { type: 'mrkdwn', text: `🚨 *Campaign overdue: ${campaign.name}*\nDue *${campaign.dueDate}*. ${Object.keys(byReviewer).length} reviewer(s) still have pending channels. Consider following up or reassigning.` }
        }]
      });
      escalated = true;
    } catch (e) {
      console.error('[REMINDER] escalation failed:', e.message);
    }
  }

  return { reminded, escalated };
}

module.exports = { sendReviewReminders, pendingByReviewer, reminderDue };
