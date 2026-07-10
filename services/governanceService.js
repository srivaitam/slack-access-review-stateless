// F-011: read-only governance analyses computed over an access snapshot.
// Every function here is pure (snapshot in → findings out) so it can be unit
// tested without Slack. Consumed by views/insightsView.js.

const SENSITIVE_KEYWORDS = ['finance', 'financial', 'payroll', 'hr', 'legal', 'exec', 'executive', 'board', 'confidential', 'sensitive', 'admin', 'security'];

function isSensitive(name) {
  const n = String(name || '').toLowerCase();
  return SENSITIVE_KEYWORDS.some(k => n.includes(k));
}
function domainOf(email) {
  return String(email || '').split('@')[1]?.toLowerCase() || '';
}
function isExternal(member, internalDomains) {
  return !internalDomains.has(domainOf(member.email));
}
function isPrivileged(m) {
  return m.role === 'Owner' || m.role === 'Admin';
}

// Channel risk banding + the riskiest channels.
function riskDistribution(snapshot) {
  const bands = { Critical: 0, High: 0, Medium: 0, Low: 0 };
  for (const c of snapshot.channels) {
    const r = c.riskScore || 0;
    bands[r >= 80 ? 'Critical' : r >= 60 ? 'High' : r >= 40 ? 'Medium' : 'Low']++;
  }
  const top = [...snapshot.channels]
    .sort((a, b) => (b.riskScore || 0) - (a.riskScore || 0))
    .slice(0, 10)
    .map(c => ({ name: c.channel.name, risk: c.riskScore || 0, is_private: c.channel.is_private }));
  return { bands, top };
}

// Guests + external users, top external domains, lingering single-channel guests.
function guestExternalReport(snapshot, internalDomains) {
  const guestChannelCount = {};
  const seenGuest = new Set();
  const seenExternal = new Set();
  const extByDomain = {};
  for (const { members } of snapshot.channels) {
    for (const m of members) {
      if (m.role === 'Guest') {
        seenGuest.add(m.id);
        guestChannelCount[m.id] = (guestChannelCount[m.id] || 0) + 1;
      }
      if (isExternal(m, internalDomains)) {
        seenExternal.add(m.id);
        const d = domainOf(m.email);
        if (d) extByDomain[d] = (extByDomain[d] || 0) + 1;
      }
    }
  }
  const topDomains = Object.entries(extByDomain).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([domain, count]) => ({ domain, count }));
  const singleChannelGuests = Object.values(guestChannelCount).filter(n => n === 1).length;
  return { guests: seenGuest.size, externals: seenExternal.size, topDomains, singleChannelGuests };
}

// Admin/owner count + admins sitting in sensitive channels.
function adminSprawl(snapshot) {
  const admins = snapshot.users.filter(isPrivileged);
  const adminIds = new Set(admins.map(u => u.id));
  const adminInSensitive = [];
  for (const { channel, members } of snapshot.channels) {
    if (!isSensitive(channel.name)) continue;
    const count = members.filter(m => adminIds.has(m.id)).length;
    if (count) adminInSensitive.push({ channel: channel.name, count });
  }
  return { totalAdmins: admins.length, adminInSensitive: adminInSensitive.sort((a, b) => b.count - a.count).slice(0, 10) };
}

// Channels whose creator has left, or with no active admin/owner member.
function orphanedChannels(snapshot) {
  const activeIds = new Set(snapshot.users.filter(u => u.active).map(u => u.id));
  const out = [];
  for (const { channel, members, errored } of snapshot.channels) {
    if (errored) continue;
    const creatorGone = channel.creator && !activeIds.has(channel.creator);
    const hasActiveAdmin = members.some(m => isPrivileged(m) && m.active !== false);
    if (creatorGone || !hasActiveAdmin) {
      out.push({ name: channel.name, is_private: channel.is_private, reason: creatorGone ? 'creator left the workspace' : 'no active admin/owner' });
    }
  }
  return out.slice(0, 15);
}

// Separation of duties: users in both a "request" and an "approval" channel.
function separationOfDuties(snapshot) {
  const flags = {}; // userId -> { name, req, app }
  for (const { channel, members } of snapshot.channels) {
    const n = channel.name.toLowerCase();
    const req = /request|requests|intake/.test(n);
    const app = /approv|sign-?off|authoriz/.test(n);
    if (!req && !app) continue;
    for (const m of members) {
      const f = flags[m.id] || (flags[m.id] = { name: m.name, req: false, app: false });
      if (req) f.req = true;
      if (app) f.app = true;
    }
  }
  const conflicts = Object.values(flags).filter(f => f.req && f.app).map(f => f.name);
  return { count: conflicts.length, conflicts: conflicts.slice(0, 20) };
}

// Built-in policy rules over the snapshot. Thresholds via opts.
function policyViolations(snapshot, internalDomains, opts = {}) {
  const maxAdminsPrivate = opts.maxAdminsPrivate || 2;
  const out = [];
  for (const { channel, members } of snapshot.channels) {
    if (isSensitive(channel.name)) {
      const ext = members.filter(m => isExternal(m, internalDomains)).length;
      if (ext) out.push({ rule: 'External users in a sensitive channel', channel: channel.name, detail: `${ext} external` });
    }
    if (channel.is_private) {
      const admins = members.filter(isPrivileged).length;
      if (admins > maxAdminsPrivate) out.push({ rule: `Private channel with >${maxAdminsPrivate} admins`, channel: channel.name, detail: `${admins} admins` });
    }
    const deactivated = members.filter(m => m.active === false).length;
    if (deactivated) out.push({ rule: 'Deactivated users still in a channel', channel: channel.name, detail: `${deactivated} deactivated` });
  }
  return out.slice(0, 25);
}

// Review decisions (remove/flag) recorded in campaigns — the remediation backlog.
function remediationQueue(campaigns) {
  let removals = 0, flags = 0;
  const items = [];
  for (const c of campaigns || []) {
    for (const ch of c.channels || []) {
      for (const d of Object.values(ch.decisions || {})) {
        if (d.decision === 'remove') { removals++; items.push({ campaign: c.name, channel: ch.name, decision: 'remove' }); }
        else if (d.decision === 'flag') { flags++; items.push({ campaign: c.name, channel: ch.name, decision: 'flag' }); }
      }
    }
  }
  return { removals, flags, total: removals + flags, items: items.slice(0, 20) };
}

module.exports = {
  isSensitive,
  riskDistribution,
  guestExternalReport,
  adminSprawl,
  orphanedChannels,
  separationOfDuties,
  policyViolations,
  remediationQueue
};
