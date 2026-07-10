// F-012: pick a review campaign to export its attestation (evidence) report.
function buildAttestationModal(campaigns = []) {
  const options = campaigns.slice(0, 100).map(c => ({
    text: { type: 'plain_text', text: `${c.name}${c.status ? ` — ${c.status}` : ''}`.slice(0, 75) },
    value: c.id
  }));

  const modal = {
    type: 'modal',
    callback_id: 'attestation_modal',
    title: { type: 'plain_text', text: 'Attestation Report' },
    close: { type: 'plain_text', text: 'Cancel' },
    blocks: options.length
      ? [
        {
          type: 'input',
          block_id: 'att_campaign',
          label: { type: 'plain_text', text: 'Campaign' },
          element: { type: 'static_select', action_id: 'campaign', placeholder: { type: 'plain_text', text: 'Select a review campaign…' }, options }
        },
        { type: 'context', elements: [{ type: 'mrkdwn', text: 'Exports one row per membership — decision, reviewer, timestamp, and justification. This is the access-certification evidence auditors ask for.' }] }
      ]
      : [{ type: 'section', text: { type: 'mrkdwn', text: '_No campaigns yet. Launch a review campaign first, then export its attestation report here._' } }]
  };
  if (options.length) modal.submit = { type: 'plain_text', text: 'Export' };
  return modal;
}

module.exports = { buildAttestationModal };
