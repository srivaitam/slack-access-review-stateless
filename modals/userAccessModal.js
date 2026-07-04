const { getRiskEmoji, getRiskLevel } = require('../services/riskScoringService');

function buildUserAccessModal(userAccess) {
  const { user, channels, publicChannels, privateChannels, highRiskChannels, aggregateRiskScore } = userAccess;

  // Sort: high risk first, then private, then alphabetical
  const sortedChannels = [...channels].sort((a, b) => {
    if (b.riskScore !== a.riskScore) return b.riskScore - a.riskScore;
    if (b.is_private !== a.is_private) return b.is_private ? 1 : -1;
    return a.name.localeCompare(b.name);
  });

  // Embed channel data in metadata so submission handler doesn't need to re-fetch
  // Keep only what we need to stay under Slack's 3000 char metadata limit
  const channelsMeta = sortedChannels.map(ch => ({
    id: ch.id,
    name: ch.name,
    is_private: ch.is_private,
    riskScore: ch.riskScore || 0
  }));

  const privateMetadata = JSON.stringify({
    userId: user.id,
    userName: user.name,
    userEmail: user.email,
    channels: channelsMeta
  });

  const blocks = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: '*' + user.name + '*\n' +
              '📧 ' + user.email + ' | 👤 ' + user.role + '\n' +
              '📊 Risk Score: ' + aggregateRiskScore + '/100 ' + getRiskEmoji(aggregateRiskScore) + ' ' + getRiskLevel(aggregateRiskScore)
      }
    },
    {
      type: 'context',
      elements: [{
        type: 'mrkdwn',
        text: '📢 ' + channels.length + ' total | 🔓 ' + publicChannels.length + ' public | 🔒 ' + privateChannels.length + ' private | ⚠️ ' + highRiskChannels.length + ' high-risk'
      }]
    },
    { type: 'divider' }
  ];

  // No channels case
  if (channels.length === 0) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: '_This user has no accessible channel memberships._' }
    });
    return {
      type: 'modal',
      callback_id: 'user_access_modal',
      title: { type: 'plain_text', text: 'User Access Detail' },
      close: { type: 'plain_text', text: 'Close' },
      private_metadata: privateMetadata,
      blocks
    };
  }

  blocks.push({
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: '*Select channels to revoke access:*\n_Check boxes then click Revoke Selected._'
    }
  });

  // Slack max 10 options per checkbox group - chunk them
  const chunkSize = 10;
  for (let i = 0; i < sortedChannels.length; i += chunkSize) {
    const chunk = sortedChannels.slice(i, i + chunkSize);

    const options = chunk.map(channel => ({
      text: {
        type: 'mrkdwn',
        text: (channel.is_private ? '🔒' : '🔓') + ' *#' + channel.name + '*' +
              (channel.riskScore > 0 ? ' | Risk: ' + channel.riskScore + ' ' + getRiskEmoji(channel.riskScore) : ' 🟢')
      },
      description: {
        type: 'plain_text',
        text: (channel.is_private ? 'Private' : 'Public') + ' channel'
      },
      value: channel.id
    }));

    if (i === 0 && highRiskChannels.length > 0) {
      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: '⚠️ *High risk channels listed first*' }
      });
    }

    blocks.push({
      type: 'actions',
      block_id: 'channel_select_' + i,
      elements: [{
        type: 'checkboxes',
        action_id: 'channel_checkbox_' + i,
        options
      }]
    });
  }

  blocks.push({ type: 'divider' });
  blocks.push({
    type: 'context',
    elements: [{
      type: 'mrkdwn',
      text: '⚠️ *Revocation is immediate and irreversible.* All actions are audit logged.'
    }]
  });

  return {
    type: 'modal',
    callback_id: 'user_access_modal',
    title: { type: 'plain_text', text: 'User Access Detail' },
    submit: { type: 'plain_text', text: '🚫 Revoke Selected' },
    close: { type: 'plain_text', text: 'Cancel' },
    private_metadata: privateMetadata,
    blocks
  };
}

module.exports = { buildUserAccessModal };
