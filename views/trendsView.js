// F-014: Trends & access-drift dashboard (App Home), built from stored snapshot
// history. `series` is oldest→newest totals; `drift` is prev→latest membership diff.
function arrow(cur, prev) {
  if (prev == null) return '';
  const d = cur - prev;
  return d > 0 ? ` ▲${d}` : d < 0 ? ` ▼${-d}` : ' –';
}

function buildTrendsView(series, drift) {
  const blocks = [
    { type: 'header', text: { type: 'plain_text', text: '📈 Trends & drift' } },
    {
      type: 'actions', elements: [
        { type: 'button', text: { type: 'plain_text', text: '← Back to dashboard' }, action_id: 'rev_back_dashboard' },
        { type: 'button', text: { type: 'plain_text', text: '🔄 Refresh' }, action_id: 'open_trends' }
      ]
    },
    { type: 'divider' }
  ];

  if (!series || series.length === 0) {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: '_No snapshot history captured yet._ History is recorded periodically (about every 12 hours) whenever the access data is scanned. Check back after a day or two of use, or refresh the dashboard over time.' } });
    return { type: 'home', blocks };
  }

  const latest = series[series.length - 1];
  const prev = series[series.length - 2] || null;
  blocks.push({
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: `*Latest — ${new Date(latest.at).toLocaleString()}*\n` +
        `👥 Members ${latest.users}${arrow(latest.users, prev && prev.users)}\n` +
        `📢 Channels ${latest.channels}${arrow(latest.channels, prev && prev.channels)}\n` +
        `🌐 External users ${latest.external}${arrow(latest.external, prev && prev.external)}\n` +
        `👤 Guests ${latest.guests}${arrow(latest.guests, prev && prev.guests)}\n` +
        `⚠️ High-risk channels ${latest.highRiskChannels}${arrow(latest.highRiskChannels, prev && prev.highRiskChannels)}`
    }
  });

  const hist = series.slice(-8).map(s => `${new Date(s.at).toLocaleDateString()} — ${s.users} members · ${s.channels} channels · ${s.external} external · ${s.guests} guests`).join('\n');
  blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: '*History*\n' + hist }] });

  blocks.push({ type: 'divider' });
  if (drift) {
    const examples = drift.left.slice(0, 5).map(x => `#${x.channel}`).join(', ');
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: '*Access drift since previous snapshot*\n' +
          `➕ ${drift.joined.length} membership(s) added · ➖ ${drift.left.length} removed · 🌐 external ${drift.externalDelta >= 0 ? '+' : ''}${drift.externalDelta}` +
          (drift.newHighRisk.length ? `\n🆕 newly high-risk: ${drift.newHighRisk.slice(0, 5).join(', ')}` : '') +
          (examples ? `\n_Removed from: ${examples}${drift.left.length > 5 ? '…' : ''}_` : '')
      }
    });
  } else {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: '_Drift needs at least two snapshots — it will appear after the next capture._' } });
  }

  return { type: 'home', blocks };
}

module.exports = { buildTrendsView };
