const { generateAccessSnapshot } = require('../services/accessService');
const { getRiskLevel } = require('../services/riskScoringService');

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
    metadata: snapshot.metadata
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

module.exports = { generateCSV, generateExcelXML, csvEscape };
