// F-007: multi-channel revoke. Pick a user, pick many channels, give a reason,
// and remove them from all selected channels in one action. All fields are in
// input blocks so their values are reliably present in view.state.values on
// submit.
const NOTIFY_OPTION = {
  text: { type: 'plain_text', text: 'Notify the user via Slack DM' },
  value: 'notify'
};

function buildRevokeAccessModal() {
  return {
    type: 'modal',
    callback_id: 'revoke_access_modal',
    title: { type: 'plain_text', text: 'Revoke Access' },
    submit: { type: 'plain_text', text: '🚫 Revoke' },
    close: { type: 'plain_text', text: 'Cancel' },
    blocks: [
      {
        type: 'input',
        block_id: 'revoke_user',
        label: { type: 'plain_text', text: 'User to revoke' },
        element: {
          type: 'users_select',
          action_id: 'user',
          placeholder: { type: 'plain_text', text: 'Select a person…' }
        }
      },
      {
        type: 'input',
        block_id: 'revoke_channels',
        label: { type: 'plain_text', text: 'Channels to remove them from' },
        element: {
          type: 'multi_conversations_select',
          action_id: 'channels',
          placeholder: { type: 'plain_text', text: 'Select one or more channels…' },
          filter: { include: ['public', 'private'], exclude_bot_users: true }
        }
      },
      {
        type: 'input',
        block_id: 'revoke_reason',
        label: { type: 'plain_text', text: 'Reason (recorded in the audit log)' },
        element: {
          type: 'plain_text_input',
          action_id: 'reason',
          multiline: true,
          min_length: 10,
          placeholder: { type: 'plain_text', text: 'e.g. Left the project in May; access no longer required.' }
        }
      },
      {
        type: 'input',
        block_id: 'revoke_notify',
        optional: true,
        label: { type: 'plain_text', text: 'Notifications' },
        element: {
          type: 'checkboxes',
          action_id: 'notify',
          initial_options: [NOTIFY_OPTION],
          options: [NOTIFY_OPTION]
        }
      },
      {
        type: 'context',
        elements: [{
          type: 'mrkdwn',
          text: '🔴 *Immediate and irreversible.* Public channels are joined automatically; for private channels the bot must already be a member. Failures are reported back per channel.'
        }]
      }
    ]
  };
}

module.exports = { buildRevokeAccessModal };
