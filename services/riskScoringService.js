// Risk weights are configurable via RISK_WEIGHTS (JSON env), else defaults.
// Internal domains: in-app configured (settingsService) > INTERNAL_EMAIL_DOMAINS
// env > majority auto-detect.
const { getCachedInternalDomains } = require('./settingsService');
const DEFAULT_WEIGHTS = { externalUsers: 30, guestUsers: 25, privilegedUsers: 20, inactiveUsers: 15, sensitiveChannel: 10 };

function getWeights() {
  if (process.env.RISK_WEIGHTS) {
    try { return { ...DEFAULT_WEIGHTS, ...JSON.parse(process.env.RISK_WEIGHTS) }; }
    catch (e) { console.warn('[RISK] Invalid RISK_WEIGHTS JSON, using defaults:', e.message); }
  }
  return DEFAULT_WEIGHTS;
}

function getInternalDomains(users) {
  const configured = getCachedInternalDomains();
  if (configured && configured.length) return new Set(configured.map(d => d.toLowerCase()));
  const env = process.env.INTERNAL_EMAIL_DOMAINS;
  if (env) return new Set(env.split(',').map(d => d.trim().toLowerCase()).filter(Boolean));
  return new Set([getPrimaryDomain(users).toLowerCase()]);
}

function calculateChannelRisk({ channel, members, allUsers }) {
  let riskScore = 0;
  const weights = getWeights();
  if (members.length === 0) return 0;
  const internalDomains = getInternalDomains(allUsers);
  const externalCount = members.filter(m => !internalDomains.has((m.email.split('@')[1] || '').toLowerCase())).length;
  riskScore += (externalCount / members.length) * weights.externalUsers;
  const guestCount = members.filter(m => m.role === 'Guest').length;
  riskScore += (guestCount / members.length) * weights.guestUsers;
  const privilegedCount = members.filter(m => m.role === 'Owner' || m.role === 'Admin').length;
  riskScore += (privilegedCount / members.length) * weights.privilegedUsers;
  const inactiveCount = members.filter(m => !m.active).length;
  riskScore += (inactiveCount / members.length) * weights.inactiveUsers;
  const sensitiveKeywords = ['finance', 'financial', 'payroll', 'hr', 'legal', 'exec', 'executive', 'board', 'confidential', 'sensitive', 'admin', 'security'];
  const channelNameLower = channel.name.toLowerCase();
  const hasSensitiveKeyword = sensitiveKeywords.some(keyword => channelNameLower.includes(keyword));
  if (hasSensitiveKeyword && channel.is_private) riskScore += weights.sensitiveChannel;
  else if (hasSensitiveKeyword) riskScore += weights.sensitiveChannel * 0.5;
  return Math.round(Math.min(riskScore, 100));
}

function calculateUserRiskScore(userAccess) {
  if (userAccess.channels.length === 0) return 0;
  const avgChannelRisk = userAccess.channels.reduce((sum, ch) => sum + (ch.riskScore || 0), 0) / userAccess.channels.length;
  const privateChannelWeight = userAccess.privateChannels.length / userAccess.totalChannels;
  const highRiskWeight = userAccess.highRiskChannels.length / userAccess.totalChannels;
  return Math.round(avgChannelRisk * 0.5 + privateChannelWeight * 30 + highRiskWeight * 20);
}

function getPrimaryDomain(users) {
  const domainCounts = {};
  users.forEach(user => {
    const domain = user.email.split('@')[1];
    if (domain) domainCounts[domain] = (domainCounts[domain] || 0) + 1;
  });
  if (Object.keys(domainCounts).length === 0) return 'unknown';
  return Object.keys(domainCounts).reduce((a, b) => domainCounts[a] > domainCounts[b] ? a : b);
}

function getRiskLevel(score) {
  if (score >= 80) return 'Critical';
  if (score >= 60) return 'High';
  if (score >= 40) return 'Medium';
  return 'Low';
}

function getRiskEmoji(score) {
  if (score >= 80) return '🔴';
  if (score >= 60) return '🟠';
  if (score >= 40) return '🟡';
  return '🟢';
}

module.exports = { calculateChannelRisk, calculateUserRiskScore, getPrimaryDomain, getRiskLevel, getRiskEmoji, getInternalDomains };
