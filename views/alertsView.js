// Alerts tab — renders behavioral alerts pulled from AccessGuard on the App
// Home. Alerts come from accessguardClient.fetchAlerts(); this file only turns
// that payload into Block Kit. Home views are capped at 100 blocks, so the list
// is bounded (2 blocks per alert) and truncated with a note if longer.
const SEV_EMOJI = { P1: '🔴', P2: '🟠', P3: '🟡', P4: '⚪' };
const SEV_RANK = { P1: 1, P2: 2, P3: 3, P4: 4 };
const MAX_ALERTS = 30;

function sevEmoji(s) { return SEV_EMOJI[String(s || '').toUpperCase()] || '⚪'; }

function trim(str, n) {
  const s = String(str || '');
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function fmtWhen(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return isNaN(d.getTime()) ? '' : d.toLocaleString();
}

const HEADER = [
  { type: 'header', text: { type: 'plain_text', text: '🚨 Alerts' } },
  {
    type: 'context',
    elements: [{
      type: 'mrkdwn',
      text: 'Behavioral alerts from *AccessGuard* — risky OAuth grants, admin-role changes, impossible travel, data exfiltration and more, detected from Google Workspace activity.',
    }],
  },
  {
    type: 'actions',
    elements: [
      { type: 'button', text: { type: 'plain_text', text: '🔄 Refresh alerts' }, action_id: 'open_alerts', style: 'primary' },
      { type: 'button', text: { type: 'plain_text', text: '← Back to dashboard' }, action_id: 'refresh_access_data' },
    ],
  },
  { type: 'divider' },
];

function buildAlertsView({ alerts = [], configured = true, connected = true, error = null } = {}) {
  const blocks = [...HEADER];

  if (!configured) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: '⚙️ *AccessGuard isn\'t connected yet.*\nSet `ACCESSGUARD_BASE_URL` and `ACCESSGUARD_API_KEY` on this app (the same shared secret AccessGuard uses) so alerts can be pulled in.',
      },
    });
    return { type: 'home', blocks };
  }

  if (error || !connected) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: '⚠️ *Couldn\'t load alerts from AccessGuard right now.*\nThis workspace may not be linked to an AccessGuard tenant yet, or the service is temporarily unavailable. Try Refresh in a moment.',
      },
    });
    return { type: 'home', blocks };
  }

  if (!alerts.length) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: '✅ *No open alerts.*\nAccessGuard hasn\'t flagged any risky Google Workspace activity for this workspace.' },
    });
    return { type: 'home', blocks };
  }

  // Newest-first within each severity (P1 → P4).
  const sorted = alerts.slice().sort((a, b) => {
    const r = (SEV_RANK[String(a.severity).toUpperCase()] || 5) - (SEV_RANK[String(b.severity).toUpperCase()] || 5);
    if (r !== 0) return r;
    return String(b.created_at || '').localeCompare(String(a.created_at || ''));
  });

  const counts = sorted.reduce((m, a) => {
    const s = String(a.severity || '').toUpperCase();
    m[s] = (m[s] || 0) + 1;
    return m;
  }, {});
  const countText = ['P1', 'P2', 'P3', 'P4']
    .filter(s => counts[s])
    .map(s => `${sevEmoji(s)} ${counts[s]} ${s}`)
    .join('  ·  ');

  blocks.push({
    type: 'section',
    text: { type: 'mrkdwn', text: `*${sorted.length} open alert${sorted.length === 1 ? '' : 's'}*${countText ? `  ·  ${countText}` : ''}` },
  });
  blocks.push({ type: 'divider' });

  const shown = sorted.slice(0, MAX_ALERTS);
  shown.forEach(a => {
    const sev = String(a.severity || '').toUpperCase();
    const title = a.title || a.alert_type || 'Alert';
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `${sevEmoji(sev)} *[${sev}] ${trim(title, 140)}*${a.detail ? `\n${trim(a.detail, 280)}` : ''}` },
    });
    const meta = [a.alert_type, a.user_email, fmtWhen(a.created_at)].filter(Boolean).join(' · ');
    if (meta) blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: trim(meta, 150) }] });
  });

  if (sorted.length > MAX_ALERTS) {
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `Showing the ${MAX_ALERTS} highest-severity of ${sorted.length} open alerts. Resolve or acknowledge them in AccessGuard → Reports → Behavioral alerts.` }],
    });
  }

  return { type: 'home', blocks };
}

module.exports = { buildAlertsView };
