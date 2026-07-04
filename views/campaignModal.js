// F-003: campaign creation modal.
function buildCampaignCreateModal() {
  const defaultDue = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  return {
    type: 'modal',
    callback_id: 'campaign_create_modal',
    title: { type: 'plain_text', text: 'New Review Campaign' },
    submit: { type: 'plain_text', text: 'Launch' },
    close: { type: 'plain_text', text: 'Cancel' },
    blocks: [
      {
        type: 'input',
        block_id: 'campaign_name',
        label: { type: 'plain_text', text: 'Campaign name' },
        element: {
          type: 'plain_text_input',
          action_id: 'name_input',
          max_length: 120,
          placeholder: { type: 'plain_text', text: 'e.g. Q3 2026 channel access review' }
        }
      },
      {
        type: 'input',
        block_id: 'campaign_scope',
        label: { type: 'plain_text', text: 'Scope' },
        element: {
          type: 'static_select',
          action_id: 'scope_select',
          initial_option: { text: { type: 'plain_text', text: '🔒 Private channels only' }, value: 'private' },
          options: [
            { text: { type: 'plain_text', text: '📢 All channels' }, value: 'all' },
            { text: { type: 'plain_text', text: '🔒 Private channels only' }, value: 'private' },
            { text: { type: 'plain_text', text: '⚠️ High-risk channels only (risk ≥ 70)' }, value: 'high_risk' }
          ]
        }
      },
      {
        type: 'input',
        block_id: 'campaign_due',
        label: { type: 'plain_text', text: 'Due date' },
        element: { type: 'datepicker', action_id: 'due_date', initial_date: defaultDue }
      },
      {
        type: 'input',
        block_id: 'campaign_recurrence',
        label: { type: 'plain_text', text: 'Recurrence' },
        element: {
          type: 'static_select',
          action_id: 'recurrence_select',
          initial_option: { text: { type: 'plain_text', text: 'One-off (no recurrence)' }, value: 'none' },
          options: [
            { text: { type: 'plain_text', text: 'One-off (no recurrence)' }, value: 'none' },
            { text: { type: 'plain_text', text: 'Monthly' }, value: 'monthly' },
            { text: { type: 'plain_text', text: 'Quarterly' }, value: 'quarterly' }
          ]
        }
      },
      {
        type: 'context',
        elements: [{
          type: 'mrkdwn',
          text: 'On launch, each in-scope channel\'s creator gets a DM checklist to Keep/Remove/Flag every member (falls back to you if the creator left). Decisions are recorded in the tamper-evident audit log.'
        }]
      }
    ]
  };
}

module.exports = { buildCampaignCreateModal };
