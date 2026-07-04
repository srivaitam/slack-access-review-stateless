const { getRiskEmoji, getRiskLevel } = require('../services/riskScoringService');

function buildAccessOverviewView(snapshot, sortBy = 'riskScore') {
  const { userAccessMap, metadata } = snapshot;
  let userAccessArray = Array.from(userAccessMap.values());

  if (sortBy === 'riskScore') {
    userAccessArray.sort((a, b) => b.aggregateRiskScore - a.aggregateRiskScore);
  }

  const blocks = [
    {
      type: 'header',
      text: { type: 'plain_text', text: '🔐 Access Management Dashboard' }
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Workspace Overview*\n👥 ${metadata.totalUsers} users | 📢 ${metadata.totalChannels} channels | ⏱️ Updated: ${new Date(metadata.generatedAt).toLocaleString()}`
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
    { type: 'divider' }
  ];

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
          text: `*${userAccess.user.name}* ${riskEmoji}\n📧 ${userAccess.user.email}\n📊 Risk: ${userAccess.aggregateRiskScore}/100 (${riskLevel})`
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
