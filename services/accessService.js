const pLimit = require('p-limit');
const { getAllUsers } = require('../slack/users');
const { getAllChannels } = require('../slack/channels');
const { getChannelMembers } = require('../slack/channelMembers');
const { calculateChannelRisk, calculateUserRiskScore } = require('./riskScoringService');
const { logInfo } = require('../utils/logger');
const { getCurrentTeamId } = require('../slack/client');

// Short-TTL in-memory snapshot cache (H2): reuse a recent scan across the
// dashboard, detail modal, and exports instead of re-scanning on every click.
// Keyed per workspace — one installing team must never see another's snapshot.
const SNAPSHOT_TTL_MS = Number(process.env.SNAPSHOT_TTL_MS || 60000);
const _caches = new Map(); // teamId -> { at, snapshot }

async function generateAccessSnapshot(options = {}) {
  const startTime = Date.now();
  const { onProgress, force = false } = options;
  const teamId = getCurrentTeamId();
  const _cache = _caches.get(teamId) || { at: 0, snapshot: null };

  if (!force && _cache.snapshot && (Date.now() - _cache.at) < SNAPSHOT_TTL_MS) {
    if (onProgress) onProgress(100, 'Loaded from recent cache');
    return _cache.snapshot;
  }

  if (onProgress) onProgress(10, 'Fetching workspace users...');
  const users = await getAllUsers();
  const userMap = new Map(users.map(u => [u.id, u]));

  if (onProgress) onProgress(30, 'Fetching workspace channels...');
  const channels = await getAllChannels();

  if (onProgress) onProgress(40, 'Fetching channel memberships...');
  const limit = pLimit(parseInt(process.env.MAX_CONCURRENT_API_CALLS || '10'));
  let processedCount = 0;

  const channelData = await Promise.all(
    channels.map(channel =>
      limit(async () => {
        try {
          const memberIds = await getChannelMembers(channel.id);
          const members = memberIds.filter(id => userMap.has(id)).map(id => userMap.get(id));
          const riskScore = calculateChannelRisk({ channel, members, allUsers: users });
          processedCount++;
          if (onProgress && processedCount % 10 === 0) {
            const percent = 40 + Math.floor((processedCount / channels.length) * 50);
            onProgress(percent, `Processed ${processedCount}/${channels.length} channels`);
          }
          return { channel, members, memberIds, riskScore };
        } catch (error) {
          // Do NOT report a failed lookup as an empty channel (H6) — flag it so
          // the review can distinguish "no members" from "couldn't be read".
          console.error('[SNAPSHOT] members lookup failed for ' + channel.id + ': ' + (error.data?.error || error.message));
          return { channel, members: [], memberIds: [], riskScore: 0, errored: true };
        }
      })
    )
  );

  if (onProgress) onProgress(90, 'Building access map...');
  const userAccessMap = buildUserAccessMap(channelData, userMap);
  const duration = Date.now() - startTime;
  logInfo(`✅ Access snapshot generated in ${duration}ms`);
  if (onProgress) onProgress(100, 'Complete!');

  const erroredChannels = channelData.filter(c => c.errored).length;
  const snapshot = {
    users: Array.from(userMap.values()),
    channels: channelData,
    userAccessMap,
    metadata: {
      generatedAt: new Date().toISOString(),
      totalUsers: users.length,
      totalChannels: channels.length,
      erroredChannels,
      durationMs: duration
    }
  };
  _caches.set(teamId, { at: Date.now(), snapshot });
  return snapshot;
}

function buildUserAccessMap(channelData, userMap) {
  const accessMap = new Map();
  userMap.forEach((user, userId) => {
    accessMap.set(userId, {
      user,
      channels: [],
      publicChannels: [],
      privateChannels: [],
      highRiskChannels: [],
      totalChannels: 0,
      aggregateRiskScore: 0
    });
  });
  channelData.forEach(({ channel, members, riskScore }) => {
    members.forEach(member => {
      const userAccess = accessMap.get(member.id);
      if (userAccess) {
        const channelWithRisk = { ...channel, riskScore };
        userAccess.channels.push(channelWithRisk);
        if (channel.is_private) {
          userAccess.privateChannels.push(channelWithRisk);
        } else {
          userAccess.publicChannels.push(channelWithRisk);
        }
        if (riskScore >= 70) {
          userAccess.highRiskChannels.push(channelWithRisk);
        }
        userAccess.totalChannels++;
      }
    });
  });
  accessMap.forEach((userAccess, userId) => {
    userAccess.aggregateRiskScore = calculateUserRiskScore(userAccess);
  });
  return accessMap;
}

// Clear the cached snapshot so the next read re-scans (R1: call after a revoke).
function invalidateSnapshotCache() {
  _caches.delete(getCurrentTeamId());
}

module.exports = { generateAccessSnapshot, buildUserAccessMap, invalidateSnapshotCache };
