// F-006: App Home review flow — a sustainable alternative to the per-member
// DM overflow checklist. Two levels:
//   Level 1  buildReviewIndexView   — the reviewer's channel queue with progress
//   Level 2  buildReviewRosterView  — one channel's members, filtered + paginated,
//            with checkbox multi-select and bulk Keep/Revoke/Flag.
//
// Everything is built from the campaign object (no fresh Slack snapshot needed):
// campaign.channels[].members + .decisions already hold what we render.
//
// Slack Block Kit limits that shape this file:
//   • home view      ≤ 100 blocks   → the roster and index are paginated
//   • checkboxes     ≤ 10 options   → members are chunked into groups of 10
//   • a home view carries navigation state in private_metadata (parsed back out
//     by the action handlers).
const { getRiskEmoji } = require('../services/riskScoringService');

const PAGE_SIZES = [10, 25, 50];
const DEFAULT_PAGE_SIZE = 25;
const CHECKBOX_CHUNK = 10;   // Slack hard cap on options per checkbox group
const INDEX_MAX = 40;        // channels shown at once on the index (block budget)

// ── Pure helpers (unit-tested in test/reviewPagination.test.js) ─────────────

/** A member that warrants explicit attention rather than a bulk keep. */
function isException(member) {
  return member.role === 'Guest' || member.active === false ||
    member.role === 'Owner' || member.role === 'Admin';
}

function hasDecision(channel, memberId) {
  return Boolean(channel.decisions && channel.decisions[memberId]);
}

function channelProgress(channel) {
  const total = channel.members.length;
  let decided = 0;
  for (const m of channel.members) if (hasDecision(channel, m.id)) decided++;
  return { total, decided, remaining: total - decided, percent: total ? Math.round((decided / total) * 100) : 100 };
}

/**
 * Members to show for a filter:
 *   'todo'      → undecided
 *   'attention' → undecided AND exception (guest / deactivated / admin / owner)
 *   'all'       → everyone
 */
function filterRoster(channel, filter) {
  const members = channel.members;
  if (filter === 'all') return members.slice();
  const undecided = members.filter(m => !hasDecision(channel, m.id));
  if (filter === 'attention') return undecided.filter(isException);
  return undecided; // 'todo' (default)
}

function clampPageSize(n) {
  const v = Number(n);
  return PAGE_SIZES.includes(v) ? v : DEFAULT_PAGE_SIZE;
}

/** Clamp a page index and return the slice + paging metadata. */
function paginate(items, page, pageSize) {
  const size = clampPageSize(pageSize);
  const total = items.length;
  const pages = Math.max(1, Math.ceil(total / size));
  const p = Math.min(Math.max(0, Number(page) || 0), pages - 1);
  const start = p * size;
  const end = Math.min(start + size, total);
  return { slice: items.slice(start, end), page: p, pages, total, start, end, pageSize: size };
}

function progressBar(percent) {
  const filled = Math.round(percent / 10);
  return '█'.repeat(filled) + '░'.repeat(10 - filled);
}

function memberFlagText(m) {
  const flags = [];
  if (m.role === 'Guest') flags.push('👤 guest');
  if (m.role === 'Owner' || m.role === 'Admin') flags.push('🛡 ' + m.role.toLowerCase());
  if (m.active === false) flags.push('🚫 deactivated');
  return flags.join(' · ');
}

function trim(str, n) {
  const s = String(str || '');
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

// ── Level 1: channel index (the reviewer's queue) ───────────────────────────

/**
 * Channels this viewer is responsible for. Admins see every channel; everyone
 * else sees only the channels they are the assigned reviewer for.
 */
function reviewableChannels(campaign, userId, isAdmin) {
  return campaign.channels.filter(c => isAdmin || c.reviewerId === userId);
}

function buildReviewIndexView({ campaign, userId, isAdmin = false }) {
  const channels = reviewableChannels(campaign, userId, isAdmin);
  // Least-complete, highest-risk first so the work that matters surfaces.
  const ranked = channels
    .map(c => ({ c, p: channelProgress(c) }))
    .sort((a, b) => a.p.percent - b.p.percent || (b.c.riskScore || 0) - (a.c.riskScore || 0));

  const done = ranked.filter(x => x.p.remaining === 0).length;
  const overdue = campaign.dueDate && campaign.dueDate < new Date().toISOString().slice(0, 10);

  const blocks = [
    { type: 'header', text: { type: 'plain_text', text: '📋 ' + trim(campaign.name, 140) } },
    {
      type: 'context',
      elements: [{
        type: 'mrkdwn',
        text: `Due *${campaign.dueDate}*${overdue ? ' ⏰ *overdue*' : ''} · scope ${campaign.scope} · ` +
          `${done}/${channels.length} of your channels complete` +
          (isAdmin ? ' · _admin view: all channels_' : '')
      }]
    },
    {
      type: 'actions',
      elements: [
        { type: 'button', text: { type: 'plain_text', text: '← Back to dashboard' }, action_id: 'rev_back_dashboard' },
        { type: 'button', text: { type: 'plain_text', text: '🔄 Refresh' }, action_id: 'rev_open_index', value: campaign.id }
      ]
    },
    { type: 'divider' }
  ];

  if (channels.length === 0) {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: '_You have no channels to review in this campaign._' } });
    return { type: 'home', private_metadata: JSON.stringify({ v: 'idx', c: campaign.id }), blocks };
  }

  const shown = ranked.slice(0, INDEX_MAX);
  for (const { c, p } of shown) {
    const attn = filterRoster(c, 'attention').length;
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `${getRiskEmoji(c.riskScore || 0)} *#${trim(c.name, 60)}*  ${c.is_private ? '🔒' : '📢'}\n` +
          `\`${progressBar(p.percent)}\` ${p.percent}% · ${p.decided}/${p.total} reviewed` +
          (attn > 0 ? ` · ⚠️ ${attn} need attention` : '')
      },
      accessory: p.remaining === 0
        ? { type: 'button', text: { type: 'plain_text', text: '✅ Done — reopen' }, action_id: 'rev_open', value: `${campaign.id}|${c.id}` }
        : { type: 'button', text: { type: 'plain_text', text: 'Review' }, action_id: 'rev_open', value: `${campaign.id}|${c.id}`, style: 'primary' }
    });
  }
  if (ranked.length > INDEX_MAX) {
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `Showing ${INDEX_MAX} of ${ranked.length} channels (least complete first). Finish these and the list refreshes.` }]
    });
  }

  return { type: 'home', private_metadata: JSON.stringify({ v: 'idx', c: campaign.id }), blocks };
}

// ── Level 2: paginated roster for one channel ───────────────────────────────

const FILTERS = [
  { key: 'todo', label: 'Undecided' },
  { key: 'attention', label: 'Needs attention' },
  { key: 'all', label: 'All' }
];

function decisionLabel(d) {
  return d === 'keep' ? '✅ Kept' : d === 'remove' ? '🗑 Marked for removal' : '🚩 Flagged';
}

function buildReviewRosterView({ campaign, channel, userId, isAdmin = false, page = 0, pageSize = DEFAULT_PAGE_SIZE, filter = 'todo', selectAll = false }) {
  const flt = FILTERS.some(f => f.key === filter) ? filter : 'todo';
  const prog = channelProgress(channel);
  const filtered = filterRoster(channel, flt);
  const pg = paginate(filtered, page, pageSize);
  const routineRemaining = filterRoster(channel, 'todo').filter(m => !isException(m)).length;

  const meta = JSON.stringify({ v: 'ros', c: campaign.id, ch: channel.id, p: pg.page, ps: pg.pageSize, f: flt });

  const blocks = [
    { type: 'header', text: { type: 'plain_text', text: trim('#' + channel.name, 148) } },
    {
      type: 'context',
      elements: [{
        type: 'mrkdwn',
        text: `${getRiskEmoji(channel.riskScore || 0)} ${campaign.name} · due ${campaign.dueDate}\n` +
          `\`${progressBar(prog.percent)}\` ${prog.percent}% · *${prog.decided}/${prog.total}* reviewed · ${prog.remaining} left`
      }]
    },
    {
      type: 'actions',
      block_id: 'rev_toolbar',
      elements: [
        ...FILTERS.map(f => ({
          type: 'button',
          text: { type: 'plain_text', text: `${f.label} (${filterRoster(channel, f.key).length})` },
          action_id: `rev_filter_${f.key}`,
          value: f.key,
          ...(f.key === flt ? { style: 'primary' } : {})
        })),
        {
          type: 'static_select',
          action_id: 'rev_pagesize',
          initial_option: { text: { type: 'plain_text', text: `${pg.pageSize} / page` }, value: String(pg.pageSize) },
          options: PAGE_SIZES.map(n => ({ text: { type: 'plain_text', text: `${n} / page` }, value: String(n) }))
        }
      ]
    }
  ];

  if (routineRemaining > 0) {
    blocks.push({
      type: 'actions',
      elements: [{
        type: 'button',
        text: { type: 'plain_text', text: `✅ Keep all remaining routine (${routineRemaining})` },
        action_id: 'rev_keep_routine',
        value: `${campaign.id}|${channel.id}`,
        confirm: {
          title: { type: 'plain_text', text: 'Keep routine members?' },
          text: { type: 'mrkdwn', text: `Mark the ${routineRemaining} undecided members with no risk flags as *Keep*. Guests, admins, and deactivated users are left for you to decide individually.` },
          confirm: { type: 'plain_text', text: 'Keep them' },
          deny: { type: 'plain_text', text: 'Cancel' }
        }
      }]
    });
  }

  blocks.push({ type: 'divider' });

  if (pg.total === 0) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: flt === 'todo' ? '🎉 *Every member of this channel has been reviewed.*' : '_Nothing matches this filter._' }
    });
  } else {
    // Bulk action bar — applies to whatever is checked below.
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: '*Select members below, then apply:*' } });
    blocks.push({
      type: 'actions',
      block_id: 'rev_bulkbar',
      elements: [
        { type: 'button', text: { type: 'plain_text', text: '✅ Keep selected' }, action_id: 'rev_bulk_keep', value: 'keep', style: 'primary' },
        { type: 'button', text: { type: 'plain_text', text: '🗑 Revoke selected' }, action_id: 'rev_bulk_remove', value: 'remove', style: 'danger' },
        { type: 'button', text: { type: 'plain_text', text: '🚩 Flag selected' }, action_id: 'rev_bulk_flag', value: 'flag' }
      ]
    });

    const undecidedSlice = pg.slice.filter(m => !hasDecision(channel, m.id));
    const decidedSlice = pg.slice.filter(m => hasDecision(channel, m.id));

    // Select all / clear for the members shown on this page.
    if (undecidedSlice.length > 0) {
      blocks.push({
        type: 'actions',
        block_id: 'rev_selectbar',
        elements: [
          { type: 'button', text: { type: 'plain_text', text: `Select all on page (${undecidedSlice.length})` }, action_id: 'rev_select_all' },
          { type: 'button', text: { type: 'plain_text', text: 'Clear' }, action_id: 'rev_clear_all' }
        ]
      });
    }

    for (let i = 0; i < undecidedSlice.length; i += CHECKBOX_CHUNK) {
      const chunk = undecidedSlice.slice(i, i + CHECKBOX_CHUNK);
      const opts = chunk.map(m => {
        const flagText = memberFlagText(m);
        return {
          text: { type: 'mrkdwn', text: trim(`*${m.name}*${flagText ? ' · ' + flagText : ''}`, 74) },
          description: { type: 'plain_text', text: trim(m.email || m.role || ' ', 74) },
          value: m.id
        };
      });
      const checkboxes = { type: 'checkboxes', action_id: `rev_select_${i}`, options: opts };
      if (selectAll) checkboxes.initial_options = opts;
      blocks.push({ type: 'actions', block_id: `rev_grp_${i}`, elements: [checkboxes] });
    }

    // Already-decided members on this page (only appears under the 'all' filter).
    decidedSlice.forEach(m => {
      const d = channel.decisions[m.id];
      blocks.push({
        type: 'context',
        elements: [{ type: 'mrkdwn', text: `${decisionLabel(d.decision)} — *${trim(m.name, 60)}* · ${d.reviewer.name}` }]
      });
    });

    // Pager
    blocks.push({ type: 'divider' });
    const pager = [];
    if (pg.page > 0) pager.push({ type: 'button', text: { type: 'plain_text', text: '‹ Prev' }, action_id: 'rev_page_prev', value: 'prev' });
    if (pg.page < pg.pages - 1) pager.push({ type: 'button', text: { type: 'plain_text', text: 'Next ›' }, action_id: 'rev_page_next', value: 'next' });
    if (pager.length) blocks.push({ type: 'actions', block_id: 'rev_pager', elements: pager });
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `Showing ${pg.total === 0 ? 0 : pg.start + 1}–${pg.end} of ${pg.total} · page ${pg.page + 1}/${pg.pages}` }]
    });
  }

  blocks.push({ type: 'divider' });
  blocks.push({
    type: 'actions',
    elements: [
      { type: 'button', text: { type: 'plain_text', text: '← All channels' }, action_id: 'rev_open_index', value: campaign.id },
      { type: 'button', text: { type: 'plain_text', text: '🏠 Dashboard' }, action_id: 'rev_back_dashboard' }
    ]
  });

  return { type: 'home', private_metadata: meta, blocks };
}

/**
 * One justification modal for a whole batch of Remove/Flag decisions. The
 * selected user ids + where-to-return context ride in private_metadata so the
 * submission handler can apply them and republish the same roster page.
 */
function buildBulkJustificationModal({ campaignId, channelId, decision, userIds, page, pageSize, filter }) {
  return {
    type: 'modal',
    callback_id: 'review_bulk_justification_modal',
    private_metadata: JSON.stringify({ campaignId, channelId, decision, userIds, page, pageSize, filter }),
    title: { type: 'plain_text', text: decision === 'remove' ? 'Revoke — justification' : 'Flag — justification' },
    submit: { type: 'plain_text', text: `Apply to ${userIds.length}` },
    close: { type: 'plain_text', text: 'Cancel' },
    blocks: [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: `You are about to *${decision === 'remove' ? 'mark for removal' : 'flag'}* *${userIds.length}* member(s). One justification is recorded against each in the audit evidence.` }
      },
      {
        type: 'input',
        block_id: 'justification',
        label: { type: 'plain_text', text: 'Why?' },
        element: {
          type: 'plain_text_input',
          action_id: 'justification_input',
          multiline: true,
          min_length: 10,
          placeholder: { type: 'plain_text', text: 'e.g. Project ended in May; access no longer required.' }
        }
      }
    ]
  };
}

module.exports = {
  buildReviewIndexView,
  buildReviewRosterView,
  buildBulkJustificationModal,
  reviewableChannels,
  // pure helpers (exported for tests)
  isException,
  channelProgress,
  filterRoster,
  clampPageSize,
  paginate,
  PAGE_SIZES,
  DEFAULT_PAGE_SIZE
};
