const { getRiskEmoji } = require('../services/riskScoringService');

function buildRevocationConfirmModal(userId, userName, userEmail, channelsToRevoke) {
  const channelList = channelsToRevoke
    .map(ch => `• ${ch.is_private ? '🔒' : '🔓'} *#${ch.name}* ${getRiskEmoji(ch.riskScore || 0)}`)
    .join('\n');

  return {
    type: 'modal',
    callback_id: 'confirm_revocation',
    title: { type: 'plain_text', text: '⚠️ Confirm Revocation' },
    submit: { type: 'plain_text', text: 'Yes, Revoke Now' },
    close: { type: 'plain_text', text: 'Go Back' },
    private_metadata: JSON.stringify({ userId, userName, userEmail, channelIds: channelsToRevoke.map(c => c.id) }),
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `⚠️ *You are about to revoke access for:*\n\n👤 *User:* ${userName}\n📧 ${userEmail}\n\n*Removing from ${channelsToRevoke.length} channel(s):*\n${channelList}`
        }
      },
      { type: 'divider' },
      {
        type: 'input',
        block_id: 'revocation_reason',
        label: { type: 'plain_text', text: '📝 Reason for revocation (required for audit log)' },
        element: {
          type: 'plain_text_input',
          action_id: 'reason_input',
          multiline: true,
          min_length: 10,
          placeholder: { type: 'plain_text', text: 'e.g. User moved to a different team and no longer requires access to these channels' }
        }
      },
      {
        type: 'input',
        block_id: 'notify_user_option',
        label: { type: 'plain_text', text: '🔔 Notifications' },
        optional: true,
        element: {
          type: 'checkboxes',
          action_id: 'notify_checkbox',
          initial_options: [{
            text: { type: 'plain_text', text: 'Notify user via Slack DM' },
            value: 'notify_user'
          }],
          options: [{
            text: { type: 'plain_text', text: 'Notify user via Slack DM' },
            value: 'notify_user'
          }]
        }
      },
      {
        type: 'context',
        elements: [{
          type: 'mrkdwn',
          text: '🔴 *This action is immediate and cannot be undone.* All actions are recorded in the audit log.'
        }]
      }
    ]
  };
}

module.exports = { buildRevocationConfirmModal };