// Customize dashboard tabs: an admin picks which toolbar buttons to hide on the
// Access Review App Home. Selected = hidden (matches the "hide selected tabs"
// intent). The hidden set is persisted per-workspace by settingsService and
// applied by usersAccessView.buildToolbar. Refresh and the Customize control
// itself are never hideable, so the full toolbar can always be restored.
const { HIDEABLE_TABS } = require('../views/usersAccessView');

function buildTabSettingsModal({ hiddenTabs = [] } = {}) {
  const hidden = new Set(hiddenTabs);
  const options = HIDEABLE_TABS.map(t => ({
    text: { type: 'plain_text', text: t.label.slice(0, 75) },
    value: t.key
  }));
  const initial = options.filter(o => hidden.has(o.value));

  const select = {
    type: 'multi_static_select',
    action_id: 'tabs_multi',
    placeholder: { type: 'plain_text', text: 'Select tabs to hide…' },
    options
  };
  if (initial.length) select.initial_options = initial;

  return {
    type: 'modal',
    callback_id: 'tab_settings_modal',
    title: { type: 'plain_text', text: 'Customize Tabs' },
    submit: { type: 'plain_text', text: 'Save' },
    close: { type: 'plain_text', text: 'Cancel' },
    blocks: [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: '*Choose which toolbar buttons to hide* on the Access Review dashboard. Whatever you select is hidden for everyone in this workspace. *Refresh* and *Customize Tabs* always stay visible so you can undo this any time.' }
      },
      {
        type: 'input',
        block_id: 'tabs_select',
        optional: true,
        label: { type: 'plain_text', text: 'Tabs to hide' },
        element: select
      },
      {
        type: 'context',
        elements: [{
          type: 'mrkdwn',
          text: hiddenTabs.length
            ? `Currently hidden: *${hiddenTabs.length}* tab(s). Clear the selection and save to show everything again.`
            : 'Nothing is hidden — every tab is currently shown.'
        }]
      }
    ]
  };
}

module.exports = { buildTabSettingsModal };
