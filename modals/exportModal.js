// F-019: export chooser (replaces the ⋯ overflow). Pick what to export; the
// file is DM'd to the admin. Channel audit pushes the channel-picker modal.
function buildExportModal() {
  const usersOpt = { text: { type: 'plain_text', text: 'Users CSV — one row per user' }, value: 'users' };
  const auditOpt = { text: { type: 'plain_text', text: 'Channel audit CSV — one row per channel × member' }, value: 'channel_audit' };
  return {
    type: 'modal',
    callback_id: 'export_modal',
    title: { type: 'plain_text', text: 'Export' },
    submit: { type: 'plain_text', text: 'Next' },
    close: { type: 'plain_text', text: 'Cancel' },
    blocks: [
      {
        type: 'input',
        block_id: 'export_kind',
        label: { type: 'plain_text', text: 'What do you want to export?' },
        element: { type: 'radio_buttons', action_id: 'kind', initial_option: usersOpt, options: [usersOpt, auditOpt] }
      },
      { type: 'context', elements: [{ type: 'mrkdwn', text: 'The file is sent to you as a direct message.' }] }
    ]
  };
}

module.exports = { buildExportModal };
