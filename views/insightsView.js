// F-011: governance insights dashboard (App Home). Renders the read-only
// analyses from services/governanceService over the current snapshot.
const gov = require('../services/governanceService');
const { getInternalDomains, getRiskEmoji } = require('../services/riskScoringService');

function buildInsightsView(snapshot, campaigns = []) {
  const internalDomains = getInternalDomains(snapshot.users);
  const risk = gov.riskDistribution(snapshot);
  const ge = gov.guestExternalReport(snapshot, internalDomains);
  const sprawl = gov.adminSprawl(snapshot);
  const orphaned = gov.orphanedChannels(snapshot);
  const sod = gov.separationOfDuties(snapshot);
  const violations = gov.policyViolations(snapshot, internalDomains);
  const rq = gov.remediationQueue(campaigns);

  const blocks = [
    { type: 'header', text: { type: 'plain_text', text: '📊 Governance insights' } },
    {
      type: 'actions', elements: [
        { type: 'button', text: { type: 'plain_text', text: '← Back to dashboard' }, action_id: 'rev_back_dashboard' },
        { type: 'button', text: { type: 'plain_text', text: '🔄 Refresh' }, action_id: 'open_insights' }
      ]
    },
    { type: 'divider' },
    { type: 'section', text: { type: 'mrkdwn', text: `*Channel risk*\n🔴 Critical ${risk.bands.Critical}  ·  🟠 High ${risk.bands.High}  ·  🟡 Medium ${risk.bands.Medium}  ·  🟢 Low ${risk.bands.Low}` } }
  ];
  if (risk.top.length) {
    blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: 'Top risk: ' + risk.top.slice(0, 5).map(c => `${getRiskEmoji(c.risk)} #${c.name} (${c.risk})`).join('  ·  ') }] });
  }

  blocks.push({ type: 'divider' });
  blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `*Guests & external*\n👤 ${ge.guests} guests (${ge.singleChannelGuests} in a single channel)  ·  🌐 ${ge.externals} external users` } });
  if (ge.topDomains.length) {
    blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: 'Top external domains: ' + ge.topDomains.map(d => `${d.domain} (${d.count})`).join(', ') }] });
  }

  blocks.push({ type: 'divider' });
  blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `*Admins*\n🛡 ${sprawl.totalAdmins} admins/owners` + (sprawl.adminInSensitive.length ? `  ·  present in ${sprawl.adminInSensitive.length} sensitive channel(s)` : '') } });
  if (sprawl.adminInSensitive.length) {
    blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: sprawl.adminInSensitive.slice(0, 6).map(a => `#${a.channel} (${a.count})`).join('  ·  ') }] });
  }

  blocks.push({ type: 'divider' });
  blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `*Orphaned channels* (${orphaned.length})` } });
  orphaned.slice(0, 8).forEach(o => blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `${o.is_private ? '🔒' : '#'} ${o.name} — ${o.reason}` }] }));
  if (orphaned.length === 0) blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: '✅ none' }] });

  blocks.push({ type: 'divider' });
  blocks.push({
    type: 'section',
    text: { type: 'mrkdwn', text: `*Separation of duties*\n${sod.count ? `⚠️ ${sod.count} user(s) in both request & approval channels: ${sod.conflicts.slice(0, 10).join(', ')}` : '✅ No request/approval conflicts found'}` }
  });

  blocks.push({ type: 'divider' });
  blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `*Policy violations* (${violations.length})` } });
  violations.slice(0, 10).forEach(vi => blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `⚠️ ${vi.rule} — #${vi.channel} (${vi.detail})` }] }));
  if (violations.length === 0) blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: '✅ none' }] });

  blocks.push({ type: 'divider' });
  blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `*Remediation queue*\n🗑 ${rq.removals} marked for removal  ·  🚩 ${rq.flags} flagged\n_From campaign decisions, awaiting enforcement via Revoke access._` } });

  // Review coverage for active campaigns (F-016).
  const activeCampaigns = (campaigns || []).filter(c => c.status === 'active');
  if (activeCampaigns.length) {
    blocks.push({ type: 'divider' });
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: '*Review coverage (active campaigns)*' } });
    activeCampaigns.slice(0, 3).forEach(c => {
      const cov = gov.reviewCoverage(c);
      const behind = cov.reviewers.filter(r => r.percent < 100 && r.reviewerId !== 'unassigned').slice(0, 3).map(r => `<@${r.reviewerId}> ${r.percent}%`).join(', ');
      blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `*${c.name}* — ${cov.percent}% (${cov.decided}/${cov.total})${cov.overdue ? ' ⏰ overdue' : ''}${behind ? ` · behind: ${behind}` : ''}` }] });
    });
  }

  return { type: 'home', blocks };
}

module.exports = { buildInsightsView };
