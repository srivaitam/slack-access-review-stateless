const { slack } = require('./client');
const { limiters } = require('./rateLimiter');

async function getChannelMembers(channelId) {
  try {
    // Paginate — large channels exceed one page and would be under-counted (C4).
    const members = [];
    let cursor;
    do {
      const result = await limiters.tier4.schedule(() => slack.conversations.members({ channel: channelId, limit: 200, cursor }));
      members.push(...(result.members || []));
      cursor = result.response_metadata?.next_cursor || undefined;
    } while (cursor);
    return members;
  } catch (error) {
    if (error.data?.error === 'channel_not_found' || error.data?.error === 'not_in_channel') {
      return [];
    }
    throw error;
  }
}

module.exports = { getChannelMembers };
