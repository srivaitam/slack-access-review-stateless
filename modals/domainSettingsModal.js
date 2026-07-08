// F-009: configure which email domains count as "internal". Members on these
// domains are internal; everyone else is external (drives risk scores + flags).
// Empty = fall back to the INTERNAL_EMAIL_DOMAINS env var, then majority auto-detect.
function buildDomainSettingsModal({ currentDomains = [], detected = '' } = {}) {
  const element = {
    type: 'plain_text_input',
    action_id: 'domains_input',
    placeholder: { type: 'plain_text', text: 'e.g. vaitam.com, vaitam.io' }
  };
  if (currentDomains.length) element.initial_value = currentDomains.join(', ');

  const hint = currentDomains.length
    ? `Currently internal: *${currentDomains.join(', ')}*.`
    : `No domains set — auto-detecting the most common domain${detected ? ` (currently *${detected}*)` : ''}.`;

  return {
    type: 'modal',
    callback_id: 'domain_settings_modal',
    title: { type: 'plain_text', text: 'Internal Domains' },
    submit: { type: 'plain_text', text: 'Save' },
    close: { type: 'plain_text', text: 'Cancel' },
    blocks: [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: '*Set your internal email domains.* Members on these domains count as *internal*; everyone else is *external* — which drives risk scores and the external flags in audits.' }
      },
      {
        type: 'input',
        block_id: 'domains',
        optional: true,
        label: { type: 'plain_text', text: 'Internal domains (comma-separated)' },
        element
      },
      { type: 'context', elements: [{ type: 'mrkdwn', text: `${hint} Leave blank to auto-detect.` }] }
    ]
  };
}

module.exports = { buildDomainSettingsModal };
