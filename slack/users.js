const { slack } = require('./client');
const { limiters } = require('./rateLimiter');

async function getAllUsers() {
  // Paginate through every page — never rely on a single page (C4).
  const members = [];
  let cursor;
  do {
    const result = await limiters.tier2.schedule(() => slack.users.list({ limit: 200, cursor }));
    members.push(...(result.members || []));
    cursor = result.response_metadata?.next_cursor || undefined;
  } while (cursor);

  return members
    .filter(u => !u.is_bot && !u.is_app_user && u.id !== 'USLACKBOT' && u.profile?.email)
    .map(u => ({
      id: u.id,
      name: u.profile.real_name || u.name,
      email: u.profile.email,
      role: u.is_owner ? 'Owner'
        : u.is_admin ? 'Admin'
        : (u.is_ultra_restricted || u.is_restricted) ? 'Guest'
        : 'Member',
      active: !u.deleted,
      is_owner: u.is_owner || false,
      is_admin: u.is_admin || false,
      is_guest: Boolean(u.is_restricted || u.is_ultra_restricted)
    }));
}

module.exports = { getAllUsers };
