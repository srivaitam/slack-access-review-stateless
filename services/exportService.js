const { generateAccessSnapshot } = require('../services/accessService');
const { getRiskLevel, getInternalDomains } = require('../services/riskScoringService');

/**
 * Generate CSV string from access snapshot
 */
async function generateCSV() {
  const snapshot = await generateAccessSnapshot();
  const rows = [];

  // Header
  rows.push([
    'User Name', 'Email', 'Role', 'Active', 'Total Channels',
    'Public Channels', 'Private Channels', 'High Risk Channels',
    'Risk Score', 'Risk Level', 'Channel List'
  ].join(','));

  const userAccessArray = Array.from(snapshot.userAccessMap.values())
    .sort((a, b) => b.aggregateRiskScore - a.aggregateRiskScore);

  for (const ua of userAccessArray) {
    const channelNames = ua.channels.map(ch => ch.name).join('; ');
    rows.push([
      csvEscape(ua.user.name),
      csvEscape(ua.user.email),
      ua.user.role,
      ua.user.active,
      ua.totalChannels,
      ua.publicChannels.length,
      ua.privateChannels.length,
      ua.highRiskChannels.length,
      ua.aggregateRiskScore,
      getRiskLevel(ua.aggregateRiskScore),
      csvEscape(channelNames)
    ].join(','));
  }

  return {
    csv: rows.join('\n'),
    metadata: snapshot.metadata
  };
}

/**
 * Generate Excel-compatible buffer (XLSX) from access snapshot
 * Uses a simple XML spreadsheet format (no extra dependency needed)
 */
async function generateExcelXML() {
  const snapshot = await generateAccessSnapshot();
  const userAccessArray = Array.from(snapshot.userAccessMap.values())
    .sort((a, b) => b.aggregateRiskScore - a.aggregateRiskScore);

  const headers = [
    'User Name', 'Email', 'Role', 'Active', 'Total Channels',
    'Public Channels', 'Private Channels', 'High Risk Channels',
    'Risk Score', 'Risk Level', 'Channel List'
  ];

  // Build rows
  const dataRows = userAccessArray.map(ua => [
    ua.user.name,
    ua.user.email,
    ua.user.role,
    ua.user.active ? 'Yes' : 'No',
    ua.totalChannels,
    ua.publicChannels.length,
    ua.privateChannels.length,
    ua.highRiskChannels.length,
    ua.aggregateRiskScore,
    getRiskLevel(ua.aggregateRiskScore),
    ua.channels.map(ch => ch.name).join('; ')
  ]);

  // Channel detail sheet rows
  const channelHeaders = [
    'Channel Name', 'Type', 'Member Count', 'Risk Score', 'Risk Level', 'Topic', 'Purpose'
  ];

  const channelRows = snapshot.channels.map(({ channel, riskScore }) => [
    channel.name,
    channel.is_private ? 'Private' : 'Public',
    channel.member_count,
    riskScore,
    getRiskLevel(riskScore),
    channel.topic || '',
    channel.purpose || ''
  ]);

  return {
    users: { headers, rows: dataRows },
    channels: { headers: channelHeaders, rows: channelRows },
    memberships: { headers: MEMBERSHIP_HEADERS, rows: buildMembershipRows(snapshot) }, // F-001
    metadata: snapshot.metadata
  };
}

// F-001: channel-centric membership export — one row per (channel, user)
// pair. This is the normalized "long" format auditors expect: sort/pivot by
// channel to certify a channel, or by user to certify a person.
function buildMembershipRows(snapshot, channelIds) {
  const internalDomains = getInternalDomains(snapshot.users);
  // Optional channel filter (F-001b): when a non-empty id list is passed, only
  // those channels are exported. Absent/empty → every scanned channel.
  const filterSet = channelIds && channelIds.length ? new Set(channelIds) : null;
  const rows = [];
  const sorted = [...snapshot.channels].sort((a, b) => b.riskScore - a.riskScore || a.channel.name.localeCompare(b.channel.name));
  for (const { channel, members, riskScore, errored } of sorted) {
    if (filterSet && !filterSet.has(channel.id)) continue;
    for (const m of members) {
      const external = !internalDomains.has((m.email.split('@')[1] || '').toLowerCase());
      rows.push([
        channel.name,
        channel.id,
        channel.is_private ? 'Private' : 'Public',
        riskScore,
        getRiskLevel(riskScore),
        m.name,
        m.email,
        m.role,
        m.active ? 'Yes' : 'No',
        external ? 'Yes' : 'No',
        m.role === 'Guest' ? 'Yes' : 'No',
        errored ? 'Partial (channel read error)' : 'Complete'
      ]);
    }
  }
  return rows;
}

const MEMBERSHIP_HEADERS = [
  'Channel', 'Channel ID', 'Type', 'Channel Risk Score', 'Channel Risk Level',
  'User Name', 'Email', 'Role', 'Active', 'External Domain', 'Guest', 'Data Quality'
];

/**
 * Generate the channel-wise audit CSV (one row per channel×user).
 */
async function generateMembershipCSV({ channelIds } = {}) {
  const snapshot = await generateAccessSnapshot();
  const memberRows = buildMembershipRows(snapshot, channelIds);
  const rows = [MEMBERSHIP_HEADERS.join(',')];
  const exported = new Set();
  for (const r of memberRows) {
    exported.add(r[1]); // channel id column
    rows.push(r.map(csvEscape).join(','));
  }
  return {
    csv: rows.join('\n'),
    metadata: {
      ...snapshot.metadata,
      totalMemberships: memberRows.length,
      exportedChannels: exported.size,
      requestedChannels: channelIds && channelIds.length ? channelIds.length : exported.size
    }
  };
}

// F-012: attestation / evidence export for a review campaign. One row per
// membership: the decision, who reviewed it, when, and the justification —
// the SOC 2 / ISO access-certification evidence Slack can't produce.
const ATTESTATION_HEADERS = [
  'Campaign', 'Channel', 'Channel Risk', 'Member Name', 'Member Email', 'Member Role',
  'Decision', 'Reviewer', 'Reviewer Email', 'Decided At', 'Justification'
];

function generateAttestationCSV(campaign) {
  const rows = [ATTESTATION_HEADERS.join(',')];
  let total = 0, decided = 0;
  for (const ch of campaign.channels || []) {
    for (const m of ch.members || []) {
      total++;
      const d = (ch.decisions || {})[m.id];
      if (d) decided++;
      rows.push([
        campaign.name,
        ch.name,
        ch.riskScore != null ? ch.riskScore : '',
        m.name,
        m.email,
        m.role,
        d ? d.decision : 'not reviewed',
        d ? d.reviewer.name : '',
        d ? d.reviewer.email : '',
        d ? d.timestamp : '',
        d ? (d.justification || '') : ''
      ].map(csvEscape).join(','));
    }
  }
  return {
    csv: rows.join('\n'),
    metadata: {
      campaign: campaign.name,
      status: campaign.status,
      dueDate: campaign.dueDate,
      total,
      decided,
      generatedAt: new Date().toISOString()
    }
  };
}

function csvEscape(val) {
  if (val == null) return '';
  let str = String(val);
  // Neutralize spreadsheet formula injection (M1): a cell beginning with
  // = + - @ (or tab/CR) is executed as a formula by Excel/Sheets. Channel
  // names, topics and display names are user-controlled, so prefix with a quote.
  if (/^[=+\-@\t\r]/.test(str)) {
    str = "'" + str;
  }
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return '"' + str.replace(/"/g, '""') + '"';
  }
  return str;
}

module.exports = { generateCSV, generateExcelXML, generateMembershipCSV, generateAttestationCSV, csvEscape };
