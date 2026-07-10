// F-018: access request + approval flow — member-facing home, the request
// modal, and the approver's DM message.

// Non-admins get this Home tab instead of the admin-only lock screen.
function buildMemberHomeView() {
  return {
    type: 'home',
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: '🔐 Access Review' } },
      { type: 'section', text: { type: 'mrkdwn', text: 'Need access to a channel? Request it here — the channel owner will be asked to approve, and the grant is recorded in the audit log.' } },
      { type: 'actions', elements: [{ type: 'button', text: { type: 'plain_text', text: '➕ Request channel access' }, action_id: 'open_access_request', style: 'primary' }] }
    ]
  };
}

function buildAccessRequestModal() {
  return {
    type: 'modal',
    callback_id: 'access_request_modal',
    title: { type: 'plain_text', text: 'Request Access' },
    submit: { type: 'plain_text', text: 'Request' },
    close: { type: 'plain_text', text: 'Cancel' },
    blocks: [
      {
        type: 'input',
        block_id: 'req_channel',
        label: { type: 'plain_text', text: 'Channel' },
        element: { type: 'conversations_select', action_id: 'channel', placeholder: { type: 'plain_text', text: 'Select a channel…' }, filter: { include: ['public', 'private'], exclude_bot_users: true } }
      },
      {
        type: 'input',
        block_id: 'req_reason',
        label: { type: 'plain_text', text: 'Why do you need access?' },
        element: { type: 'plain_text_input', action_id: 'reason', multiline: true, min_length: 10, placeholder: { type: 'plain_text', text: 'e.g. Joining the project — need the finance channel.' } }
      }
    ]
  };
}

// The DM sent to the approver, with Approve / Deny buttons.
function approverMessage(req) {
  return {
    text: `Access request from ${req.requester.name}`,
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: `🔐 *Access request*\n<@${req.requester.id}> is requesting access to *${req.isPrivate ? '🔒' : '#'}${req.channelName}*.\n_Reason:_ ${req.reason}` } },
      {
        type: 'actions',
        block_id: `ar_${req.id}`,
        elements: [
          { type: 'button', text: { type: 'plain_text', text: '✅ Approve' }, style: 'primary', action_id: 'approve_access_request', value: req.id },
          { type: 'button', text: { type: 'plain_text', text: '🚫 Deny' }, style: 'danger', action_id: 'deny_access_request', value: req.id }
        ]
      }
    ]
  };
}

module.exports = { buildMemberHomeView, buildAccessRequestModal, approverMessage };
