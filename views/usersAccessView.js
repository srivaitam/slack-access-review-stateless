const { getRiskEmoji, getRiskLevel } = require('../services/riskScoringService');
const { campaignProgress } = require('../services/campaignService');

function buildAccessOverviewView(snapshot, sortBy = 'riskScore', campaigns = []) {
  const { userAccessMap, metadata } = snapshot;
  let userAccessArray = Array.from(userAccessMap.values());

  if (sortBy === 'riskScore') {
    userAccessArray.sort((a, b) => b.aggregateRiskScore - a.aggregateRiskScore);
  }

  const people = userAccessArray.map(ua => ua.user);
  const adminCount = people.filter(u => u.role === 'Owner' || u.role === 'Admin').length;
  const guestCount = people.filter(u => u.role === 'Guest').length;
  const deactivatedCount = people.filter(u => !u.active).length;

  const blocks = [
    {
      type: 'header',
      text: { type: 'plain_text', text: '🔐 Access Management Dashboard' }
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Workspace Overview*\n👥 ${metadata.totalUsers} users — ${adminCount} admin/owner · ${guestCount} guest · ${deactivatedCount} deactivated\n📢 ${metadata.totalChannels} channels | ⏱️ Updated: ${new Date(metadata.generatedAt).toLocaleString()}`
      }
    },
    {
      type: 'actions',
      elements: [
        { type: 'button', text: { type: 'plain_text', text: '🔄 Refresh' }, action_id: 'refresh_access_data', style: 'primary' },
        { type: 'button', text: { type: 'plain_text', text: '📥 Export CSV' }, action_id: 'export_csv' },
        { type: 'button', text: { type: 'plain_text', text: '📊 Export Excel' }, action_id: 'export_excel' }
      ]
    },
    {
      type: 'actions',
      elements: [
        { type: 'button', text: { type: 'plain_text', text: '🗂 Browse Channels' }, action_id: 'browse_channels' },           // F-002
        { type: 'button', text: { type: 'plain_text', text: '📥 Channel Audit CSV' }, action_id: 'export_membership_csv' },   // F-001
        { type: 'button', text: { type: 'plain_text', text: '📋 New Review Campaign' }, action_id: 'create_campaign' }        // F-003
      ]
    },
    { type: 'divider' }
  ];

  // F-003: active campaign progress
  if (campaigns && campaigns.length > 0) {
    blocks.push({ type: 'header', text: { type: 'plain_text', text: '📋 Active Review Campaigns' } });
    campaigns.slice(0, 5).forEach(c => {
      const p = campaignProgress(c);
      const overdue = c.dueDate && c.dueDate < new Date().toISOString().slice(0, 10);
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*${c.name}*${overdue ? ' ⏰ *OVERDUE*' : ''}\n` +
            `${p.decided}/${p.total} reviewed (${p.percent}%) · 🗑 ${p.removals} removals · 🚩 ${p.flags} flags\n` +
            `📢 ${c.channels.length} channels · due ${c.dueDate} · ${c.recurrence !== 'none' ? '🔁 ' + c.recurrence : 'one-off'}`
        }
      });
    });
    blocks.push({ type: 'divider' });
  }

  if (metadata.erroredChannels > 0) {
    blocks.push(
      { type: 'section', text: { type: 'mrkdwn', text: `⚠️ *${metadata.erroredChannels} channel(s) could not be read* — membership below may be incomplete.` } },
      { type: 'divider' }
    );
  }

  userAccessArray.slice(0, 20).forEach(userAccess => {
    const riskEmoji = getRiskEmoji(userAccess.aggregateRiskScore);
    const riskLevel = getRiskLevel(userAccess.aggregateRiskScore);
    blocks.push(
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*${userAccess.user.name}* ${riskEmoji}\n📧 ${userAccess.user.email}\n👤 ${userAccess.user.role} · ${userAccess.user.active ? '✅ Active' : '🚫 Deactivated'}\n📊 Risk: ${userAccess.aggregateRiskScore}/100 (${riskLevel})`
        },
        accessory: {
          type: 'button',
          text: { type: 'plain_text', text: 'View Access' },
          action_id: 'view_user_detail',
          value: userAccess.user.id
        }
      },
      {
        type: 'context',
        elements: [{
          type: 'mrkdwn',
          text: `📢 ${userAccess.totalChannels} channels (${userAccess.publicChannels.length} public, ${userAccess.privateChannels.length} private) | ⚠️ ${userAccess.highRiskChannels.length} high-risk`
        }]
      },
      { type: 'divider' }
    );
  });

  return { type: 'home', blocks };
}

module.exports = { buildAccessOverviewView };
