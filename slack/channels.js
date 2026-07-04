const { slack } = require('./client');
const { limiters } = require('./rateLimiter');

async function getAllChannels() {
  // Paginate through every page — a single page silently truncates (C4).
  const channels = [];
  let cursor;
  do {
    const result = await limiters.tier2.schedule(() => slack.conversations.list({
      types: 'public_channel,private_channel',
      exclude_archived: true,
      limit: 200,
      cursor
    }));
    channels.push(...(result.channels || []));
    cursor = result.response_metadata?.next_cursor || undefined;
  } while (cursor);

  return channels.map(c => ({
    id: c.id,
    name: c.name || 'unknown',
    is_private: Boolean(c.is_private),
    member_count: Number(c.num_members || 0),
    created: c.created,
    creator: c.creator || null,
    topic: c.topic?.value || '',
    purpose: c.purpose?.value || ''
  }));
}

module.exports = { getAllChannels };
