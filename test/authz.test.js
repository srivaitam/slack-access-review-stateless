// Requires a token to construct the WebClient; we override the network call below.
process.env.SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN || 'xoxb-test-dummy';

const test = require('node:test');
const assert = require('node:assert');
const client = require('../slack/client');
const { isWorkspaceAdmin } = require('../utils/authz');

test('isWorkspaceAdmin gates correctly and fails closed', async () => {
  // Stub the Slack call (isWorkspaceAdmin shares this object reference).
  client.slack.users.info = async ({ user }) => {
    if (user === 'owner') return { user: { is_owner: true, is_admin: false } };
    if (user === 'admin') return { user: { is_owner: false, is_admin: true } };
    if (user === 'member') return { user: { is_owner: false, is_admin: false } };
    throw new Error('slack api error');
  };

  assert.equal(await isWorkspaceAdmin('owner'), true);
  assert.equal(await isWorkspaceAdmin('admin'), true);
  assert.equal(await isWorkspaceAdmin('member'), false);
  assert.equal(await isWorkspaceAdmin('boom'), false); // API error -> fail closed
  assert.equal(await isWorkspaceAdmin(null), false);    // no user -> false
});
