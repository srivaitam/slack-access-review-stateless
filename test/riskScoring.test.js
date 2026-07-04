const test = require('node:test');
const assert = require('node:assert');
const { getRiskLevel, getPrimaryDomain, calculateChannelRisk } = require('../services/riskScoringService');

test('getRiskLevel thresholds', () => {
  assert.equal(getRiskLevel(85), 'Critical');
  assert.equal(getRiskLevel(65), 'High');
  assert.equal(getRiskLevel(45), 'Medium');
  assert.equal(getRiskLevel(10), 'Low');
});

test('getPrimaryDomain returns the majority domain', () => {
  const users = [
    { email: 'a@acme.com' },
    { email: 'b@acme.com' },
    { email: 'c@other.com' }
  ];
  assert.equal(getPrimaryDomain(users), 'acme.com');
});

test('calculateChannelRisk scores an external member higher than an internal one', () => {
  const allUsers = [{ email: 'a@acme.com' }, { email: 'b@acme.com' }];
  const internal = calculateChannelRisk({
    channel: { name: 'general', is_private: false },
    members: [{ email: 'a@acme.com', role: 'Member', active: true }],
    allUsers
  });
  const external = calculateChannelRisk({
    channel: { name: 'general', is_private: false },
    members: [{ email: 'x@outside.com', role: 'Member', active: true }],
    allUsers
  });
  assert.ok(external > internal, 'external member should raise risk');
});
