const { getRiskEmoji, getRiskLevel } = require('../services/riskScoringService');
const { campaignProgress } = require('../services/campaignService');

const SORT_OPTIONS = [
  { text: { type: 'plain_text', text: 'Sort: risk (high → low)' }, value: 'riskScore' },
  { text: { type: 'plain_text', text: 'Sort: name (A → Z)' }, value: 'name' },
  { text: { type: 'plain_text', text: 'Sort: role' }, value: 'role' }
];

const ROLE_RANK = { Owner: 0, Admin: 1, Member: 2, Guest: 3 };

function sortUsers(arr, sortBy) {
  if (sortBy === 'name') {
    arr.sort((a, b) => a.user.name.localeCompare(b.user.name));
  } else if (sortBy === 'role') {
    arr.sort((a, b) =>
      (ROLE_RANK[a.user.role] ?? 9) - (ROLE_RANK[b.user.role] ?? 9) ||
      b.aggregateRiskScore - a.aggregateRiskScore);
  } else {
    arr.sort((a, b) => b.aggregateRiskScore - a.aggregateRiskScore);
  }
  return arr;
}

function progressBar(percent) {
  const filled = Math.round(percent / 10);
  return '█'.repeat(filled) + '░'.repeat(10 - filled);
}

function userRow(userAccess) {
  const { user, aggregateRiskScore, totalChannels, publicChannels, privateChannels, highRiskChannels } = userAccess;
  const riskEmoji = getRiskEmoji(aggregateRiskScore);
  const riskLevel = getRiskLevel(aggregateRiskScore);
  const highRisk = highRiskChannels.length > 0 ? ` · ⚠️ ${highRiskChannels.length} high-risk` : '';
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*${user.name}*  ${riskEmoji} ${aggregateRiskScore} · ${riskLevel}${user.active ? '' : '  `deactivated`'}`
      },
      accessory: {
        type: 'button',
        text: { type: 'plain_text', text: 'View access' },
        action_id: 'view_user_detail',
        value: user.id
      }
    },
    {
      type: 'context',
      elements: [{
        type: 'mrkdwn',
        text: `${user.email} · ${user.role} · ${totalChannels} channels (${publicChannels.length} public, ${privateChannels.length} private)${highRisk}`
      }]
    },
    { type: 'divider' }
  ];
}

function buildAccessOverviewView(snapshot, sortBy = 'riskScore', campaigns = [], opts = {}) {
  const { userAccessMap, metadata } = snapshot;
  const showDeactivated = Boolean(opts.showDeactivated);
  const userAccessArray = sortUsers(Array.from(userAccessMap.values()), sortBy);

  const people = userAccessArray.map(ua => ua.user);
  const adminCount = people.filter(u => u.role === 'Owner' || u.role === 'Admin').length;
  const guestCount = people.filter(u => u.role === 'Guest').length;
  const deactivatedCount = people.filter(u => !u.active).length;
  const highRiskUsers = userAccessArray.filter(ua => ua.highRiskChannels.length > 0).length;

  const active = userAccessArray.filter(ua => ua.user.active);
  const deactivated = userAccessArray.filter(ua => !ua.user.active);

  const blocks = [
    {
      type: 'header',
      text: { type: 'plain_text', text: '🔐 Access review dashboard' }
    },
    { type: 'section', text: { type: 'plain_text', text: ' ' } },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `👥 *Members:*  ${metadata.totalUsers}\n​` },
        { type: 'mrkdwn', text: `📢 *Channels:*  ${metadata.totalChannels}\n​` },
        { type: 'mrkdwn', text: `🛡️ *Admins / owners:*  ${adminCount}\n​` },
        { type: 'mrkdwn', text: `👤 *Guests:*  ${guestCount}\n​` },
        { type: 'mrkdwn', text: `🚫 *Deactivated:*  ${deactivatedCount}` },
        { type: 'mrkdwn', text: `⚠️ *High-risk users:*  ${highRiskUsers}` }
      ]
    },
    { type: 'section', text: { type: 'plain_text', text: ' ' } },
    {
      type: 'context',
      elements: [{
        type: 'mrkdwn',
        text: `Last updated ${new Date(metadata.generatedAt).toLocaleString()}` +
          (metadata.erroredChannels > 0
            ? ` · ⚠️ ${metadata.erroredChannels} channel(s) unreadable — data may be incomplete`
            : '')
      }]
    },
    {
      type: 'actions',
      elements: [
        { type: 'button', text: { type: 'plain_text', text: 'Refresh' }, action_id: 'refresh_access_data', style: 'primary' },
        {
          type: 'static_select',
          action_id: 'sort_users',
          initial_option: SORT_OPTIONS.find(o => o.value === sortBy) || SORT_OPTIONS[0],
          options: SORT_OPTIONS
        },
        { type: 'button', text: { type: 'plain_text', text: 'Browse channels' }, action_id: 'browse_channels' },
        { type: 'button', text: { type: 'plain_text', text: 'New review campaign' }, action_id: 'create_campaign' },
        { type: 'button', text: { type: 'plain_text', text: 'Revoke access' }, action_id: 'open_revoke_modal', style: 'danger' },
        {
          type: 'overflow',
          action_id: 'export_menu',
          options: [
            { text: { type: 'plain_text', text: '📥 Export users CSV' }, value: 'export_csv' },
            { text: { type: 'plain_text', text: '📋 Channel audit CSV (choose channels)' }, value: 'export_membership_csv' }
          ]
        }
      ]
    },
    { type: 'divider' }
  ];

  // F-003: active campaign progress
  if (campaigns && campaigns.length > 0) {
    blocks.push({ type: 'header', text: { type: 'plain_text', text: '📋 Active review campaigns' } });
    campaigns.slice(0, 5).forEach(c => {
      const p = campaignProgress(c);
      const overdue = c.dueDate && c.dueDate < new Date().toISOString().slice(0, 10);
      blocks.push(
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*${c.name}*${overdue ? '  ⏰ *Overdue*' : ''}\n\`${progressBar(p.percent)}\` ${p.percent}% — ${p.decided}/${p.total} reviewed`
          },
          accessory: {
            type: 'button',
            text: { type: 'plain_text', text: 'Open review' },
            action_id: 'rev_open_index',
            value: c.id,
            style: 'primary'
          }
        },
        {
          type: 'context',
          elements: [{
            type: 'mrkdwn',
            text: `${c.channels.length} channels · due ${c.dueDate} · ${c.recurrence !== 'none' ? '🔁 ' + c.recurrence : 'one-off'} · ${p.removals} removals · ${p.flags} flags`
          }]
        }
      );
    });
    blocks.push({ type: 'divider' });
  }

  // Active members
  blocks.push({
    type: 'section',
    text: { type: 'mrkdwn', text: `*Members* (${active.length} active)` }
  });
  active.slice(0, 20).forEach(ua => blocks.push(...userRow(ua)));

  // Deactivated members — collapsed by default
  if (deactivated.length > 0) {
    if (showDeactivated) {
      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: `*Deactivated* (${deactivated.length})` },
        accessory: {
          type: 'button',
          text: { type: 'plain_text', text: 'Hide' },
          action_id: 'toggle_deactivated',
          value: JSON.stringify({ show: false, sortBy })
        }
      });
      deactivated.slice(0, 20).forEach(ua => blocks.push(...userRow(ua)));
    } else {
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `🚫 *${deactivated.length} deactivated member${deactivated.length === 1 ? '' : 's'}* hidden — they retain channel memberships until removed.`
        },
        accessory: {
          type: 'button',
          text: { type: 'plain_text', text: 'Show' },
          action_id: 'toggle_deactivated',
          value: JSON.stringify({ show: true, sortBy })
        }
      });
    }
  }

  return { type: 'home', blocks };
}

module.exports = { buildAccessOverviewView };
