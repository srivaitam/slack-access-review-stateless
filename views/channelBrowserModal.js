const { getRiskEmoji, getRiskLevel } = require('../services/riskScoringService');

// F-002: channel-wise audit browser. Admin picks a channel (native typeahead,
// no 100-option limit) and the modal updates with the member list + risk flags.

const MAX_MEMBERS_SHOWN = 40; // modal block budget

function buildChannelBrowserModal() {
  return {
    type: 'modal',
    callback_id: 'channel_browser_modal',
    title: { type: 'plain_text', text: 'Channel Audit' },
    close: { type: 'plain_text', text: 'Close' },
    blocks: [
      {
        type: 'section',
        block_id: 'channel_browser_pick',
        text: { type: 'mrkdwn', text: '*Pick a channel to audit its membership:*' },
        accessory: {
          type: 'conversations_select',
          action_id: 'channel_browser_select',
          placeholder: { type: 'plain_text', text: 'Select a channel…' },
          filter: { include: ['public', 'private'], exclude_bot_users: true }
        }
      },
      {
        type: 'context',
        elements: [{ type: 'mrkdwn', text: 'Members are shown with role, guest/external and risk flags. For the full channel-by-channel dataset use *Channel Audit CSV* on the dashboard.' }]
      }
    ]
  };
}

function memberLine(m, isExternal) {
  const flags = [];
  if (m.role === 'Owner' || m.role === 'Admin') flags.push('🛡 ' + m.role);
  if (m.role === 'Guest') flags.push('👤 Guest');
  if (isExternal) flags.push('🌐 External domain');
  if (!m.active) flags.push('🚫 Deactivated');
  return `*${m.name}* — ${m.email}${flags.length ? '\n' + flags.join(' · ') : ''}`;
}

function buildChannelMembersModal(channelEntry, internalDomains) {
  const { channel, members, riskScore, errored } = channelEntry;
  const emoji = getRiskEmoji(riskScore);
  const external = (m) => !internalDomains.has((m.email.split('@')[1] || '').toLowerCase());
  const guests = members.filter(m => m.role === 'Guest').length;
  const externals = members.filter(external).length;
  const deactivated = members.filter(m => !m.active).length;

  const blocks = [
    {
      type: 'section',
      block_id: 'channel_browser_pick',
      text: { type: 'mrkdwn', text: '*Pick a channel to audit its membership:*' },
      accessory: {
        type: 'conversations_select',
        action_id: 'channel_browser_select',
        initial_conversation: channel.id,
        filter: { include: ['public', 'private'], exclude_bot_users: true }
      }
    },
    { type: 'divider' },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `${emoji} *<#${channel.id}>* — ${channel.is_private ? '🔒 Private' : '📢 Public'}\n` +
          `Risk *${riskScore}/100 (${getRiskLevel(riskScore)})* · ${members.length} member(s)\n` +
          `🌐 ${externals} external · 👤 ${guests} guest · 🚫 ${deactivated} deactivated` +
          (channel.topic ? `\n_Topic:_ ${channel.topic.slice(0, 150)}` : '')
      }
    },
    { type: 'divider' }
  ];

  if (errored) {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: '⚠️ *This channel could not be fully read* — membership below may be incomplete.' } });
  }

  // Highest-signal members first: external > guest > deactivated > admins > rest
  const rank = (m) => (external(m) ? 0 : m.role === 'Guest' ? 1 : !m.active ? 2 : (m.role === 'Owner' || m.role === 'Admin') ? 3 : 4);
  const sorted = [...members].sort((a, b) => rank(a) - rank(b));

  sorted.slice(0, MAX_MEMBERS_SHOWN).forEach(m => {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: memberLine(m, external(m)) },
      accessory: {
        type: 'button',
        text: { type: 'plain_text', text: 'View Access' },
        action_id: 'view_user_detail',
        value: m.id
      }
    });
  });

  if (members.length > MAX_MEMBERS_SHOWN) {
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `Showing ${MAX_MEMBERS_SHOWN} of ${members.length} members (riskiest first). Export *Channel Audit CSV* for the complete list.` }]
    });
  }

  return {
    type: 'modal',
    callback_id: 'channel_browser_modal',
    title: { type: 'plain_text', text: 'Channel Audit' },
    close: { type: 'plain_text', text: 'Close' },
    blocks
  };
}

module.exports = { buildChannelBrowserModal, buildChannelMembersModal };
