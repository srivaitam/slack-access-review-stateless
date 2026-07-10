// F-007: multi-channel revoke. Pick a user; the modal then loads the channels
// that user is actually in (from the access snapshot) and lets you remove them
// from any subset. Two render states:
//   channels === null → user not chosen yet (just the user picker + a hint)
//   channels is array → show a multi_static_select of that user's channels
// The chosen user id also rides in private_metadata so the submit handler never
// depends on reading a section-accessory's state.
const NOTIFY_OPTION = {
  text: { type: 'plain_text', text: 'Notify the user via Slack DM' },
  value: 'notify'
};

function buildRevokeAccessModal({ selectedUserId = null, channels = null } = {}) {
  const userSelect = {
    type: 'users_select',
    action_id: 'revoke_user_select',
    placeholder: { type: 'plain_text', text: 'Select a person…' }
  };
  if (selectedUserId) userSelect.initial_user = selectedUserId;

  const blocks = [
    { type: 'section', block_id: 'revoke_user', text: { type: 'mrkdwn', text: '*User to revoke*' }, accessory: userSelect }
  ];

  if (channels === null) {
    blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: 'Pick a user to load the channels they belong to.' }] });
  } else if (channels.length === 0) {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: '_No channels found for this user in the current scan — they may only be in private channels the app can\'t see._' } });
  } else {
    const options = channels.slice(0, 100).map(ch => ({
      text: { type: 'plain_text', text: ((ch.is_private ? '🔒 ' : '# ') + ch.name).slice(0, 75) },
      value: ch.id
    }));
    blocks.push({
      type: 'input',
      block_id: 'revoke_channels',
      optional: true,
      label: { type: 'plain_text', text: `Channels to remove them from (${channels.length})` },
      element: {
        type: 'multi_static_select',
        action_id: 'channels',
        placeholder: { type: 'plain_text', text: 'Select one or more of their channels…' },
        options
      }
    });
    if (channels.length > 100) {
      blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `Showing the first 100 of ${channels.length} channels.` }] });
    }
    // F-010: offboarding — one tick removes them from every channel the app sees.
    blocks.push({
      type: 'input',
      block_id: 'revoke_offboard',
      optional: true,
      label: { type: 'plain_text', text: 'Offboarding' },
      element: {
        type: 'checkboxes',
        action_id: 'offboard',
        options: [{ text: { type: 'plain_text', text: `Remove from ALL ${channels.length} of their channels` }, value: 'all' }]
      }
    });
  }

  blocks.push({
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
  });
  blocks.push({
    type: 'input',
    block_id: 'revoke_notify',
    optional: true,
    label: { type: 'plain_text', text: 'Notifications' },
    element: { type: 'checkboxes', action_id: 'notify', initial_options: [NOTIFY_OPTION], options: [NOTIFY_OPTION] }
  });
  blocks.push({
    type: 'context',
    elements: [{
      type: 'mrkdwn',
      text: '🔴 *Immediate and irreversible.* Public channels are joined automatically; for private channels the bot must already be a member (invite it with /invite @AccessReview).'
    }]
  });

  return {
    type: 'modal',
    callback_id: 'revoke_access_modal',
    private_metadata: JSON.stringify({ userId: selectedUserId || null }),
    title: { type: 'plain_text', text: 'Revoke Access' },
    submit: { type: 'plain_text', text: '🚫 Revoke' },
    close: { type: 'plain_text', text: 'Cancel' },
    blocks
  };
}

module.exports = { buildRevokeAccessModal };
