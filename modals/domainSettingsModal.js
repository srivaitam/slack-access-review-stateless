// F-009: classify email domains as internal/external. The modal lists every
// domain found in the workspace (with member counts); ticked = internal,
// unticked = external. An optional free-text field allows domains not present
// in the current scan (e.g. a subsidiary with no members yet). Ticking none →
// the app falls back to the INTERNAL_EMAIL_DOMAINS env var, then majority
// auto-detect.
function buildDomainSettingsModal({ discovered = [], currentDomains = [], detected = '' } = {}) {
  const blocks = [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: '*Classify your email domains.* Tick the domains that are *internal* — everyone on a domain you don\'t tick is treated as *external* (which drives risk scores and audit flags).' }
    }
  ];

  // Which options start ticked: the configured internal set, or (if none set
  // yet) the auto-detected majority domain so the current behaviour is shown.
  const preselect = new Set((currentDomains.length ? currentDomains : (detected ? [detected] : [])).map(d => d.toLowerCase()));

  // Options = discovered domains ∪ any configured domain not currently present.
  const domainCounts = new Map();
  discovered.forEach(d => domainCounts.set(String(d.domain).toLowerCase(), d.count || 0));
  currentDomains.forEach(d => { const k = d.toLowerCase(); if (!domainCounts.has(k)) domainCounts.set(k, 0); });

  const options = [...domainCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 100)
    .map(([domain, count]) => ({
      text: { type: 'plain_text', text: `${domain}${count ? ` (${count})` : ''}`.slice(0, 75) },
      value: domain
    }));

  if (options.length) {
    const select = {
      type: 'multi_static_select',
      action_id: 'domains_multi',
      placeholder: { type: 'plain_text', text: 'Select internal domains…' },
      options
    };
    const initial = options.filter(o => preselect.has(o.value));
    if (initial.length) select.initial_options = initial;
    blocks.push({ type: 'input', block_id: 'domains_select', optional: true, label: { type: 'plain_text', text: 'Internal domains' }, element: select });
  }

  blocks.push({
    type: 'input',
    block_id: 'domains_extra',
    optional: true,
    label: { type: 'plain_text', text: 'Add other internal domains (comma-separated)' },
    element: { type: 'plain_text_input', action_id: 'domains_input', placeholder: { type: 'plain_text', text: 'e.g. vaitam.io, sub.vaitam.com' } }
  });

  blocks.push({
    type: 'context',
    elements: [{
      type: 'mrkdwn',
      text: (currentDomains.length
        ? `Currently internal: *${currentDomains.join(', ')}*.`
        : `No domains set — currently auto-detecting *${detected || 'the most common domain'}* as internal.`) + ' Tick none to auto-detect.'
    }]
  });

  return {
    type: 'modal',
    callback_id: 'domain_settings_modal',
    title: { type: 'plain_text', text: 'Internal Domains' },
    submit: { type: 'plain_text', text: 'Save' },
    close: { type: 'plain_text', text: 'Cancel' },
    blocks
  };
}

module.exports = { buildDomainSettingsModal };
