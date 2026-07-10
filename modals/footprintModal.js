// F-015: per-user access footprint. Pick a person; the modal fills in every
// channel they can access — risk, private/public, external flag, and when it
// was last reviewed. Read-only (no submit).
const { getRiskEmoji } = require('../services/riskScoringService');

function buildFootprintModal({ selectedUserId = null, footprint = null } = {}) {
  const userSelect = { type: 'users_select', action_id: 'footprint_user_select', placeholder: { type: 'plain_text', text: 'Select a person…' } };
  if (selectedUserId) userSelect.initial_user = selectedUserId;

  const blocks = [
    { type: 'section', block_id: 'footprint_user', text: { type: 'mrkdwn', text: '*Access footprint*\nPick a person to see every channel they can access.' }, accessory: userSelect }
  ];

  if (footprint) {
    const u = footprint.user;
    blocks.push({ type: 'divider' });
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*${u.name}*  ${getRiskEmoji(footprint.aggregateRisk)} ${footprint.aggregateRisk}\n` +
          `${u.email} · ${u.role}${u.active === false ? ' · 🚫 deactivated' : ''}${footprint.external ? ' · 🌐 external' : ''}\n` +
          `*${footprint.totalChannels}* channel(s)`
      }
    });
    if (footprint.channels.length === 0) {
      blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: '_No channel memberships the app can see._' }] });
    }
    footprint.channels.slice(0, 40).forEach(ch => {
      const lr = ch.lastReviewed ? `reviewed ${new Date(ch.lastReviewed).toISOString().slice(0, 10)}` : 'never reviewed';
      blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `${getRiskEmoji(ch.risk)} ${ch.is_private ? '🔒' : '#'}${ch.name} · risk ${ch.risk} · ${lr}` }] });
    });
    if (footprint.channels.length > 40) {
      blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `…and ${footprint.channels.length - 40} more. Export the Channel audit CSV for the full list.` }] });
    }
  } else {
    blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: 'Their channels, risk, external flag, and last-reviewed date will appear here.' }] });
  }

  return {
    type: 'modal',
    callback_id: 'footprint_modal',
    title: { type: 'plain_text', text: 'Access Footprint' },
    close: { type: 'plain_text', text: 'Close' },
    blocks
  };
}

module.exports = { buildFootprintModal };
