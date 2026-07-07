const test = require('node:test');
const assert = require('node:assert');
const {
  isException, channelProgress, filterRoster, clampPageSize, paginate,
  buildReviewRosterView, buildReviewIndexView, DEFAULT_PAGE_SIZE
} = require('../views/reviewHomeView');

function member(id, over = {}) {
  return { id, name: 'User ' + id, email: id + '@acme.com', role: 'Member', active: true, ...over };
}

function makeChannel(members, decisions = {}, over = {}) {
  return { id: 'C1', name: 'general', is_private: false, riskScore: 50, reviewerId: 'U_me', members, decisions, ...over };
}

// ── helpers ─────────────────────────────────────────────────────────────────

test('isException flags guests, deactivated, admins and owners only', () => {
  assert.equal(isException(member('a')), false);
  assert.equal(isException(member('b', { role: 'Guest' })), true);
  assert.equal(isException(member('c', { active: false })), true);
  assert.equal(isException(member('d', { role: 'Admin' })), true);
  assert.equal(isException(member('e', { role: 'Owner' })), true);
});

test('channelProgress counts decided vs total', () => {
  const ch = makeChannel([member('a'), member('b'), member('c')], { a: { decision: 'keep' } });
  const p = channelProgress(ch);
  assert.equal(p.total, 3);
  assert.equal(p.decided, 1);
  assert.equal(p.remaining, 2);
  assert.equal(p.percent, 33);
});

test('filterRoster: todo excludes decided, attention keeps undecided exceptions, all keeps everyone', () => {
  const members = [
    member('u1'),                          // routine
    member('u2', { role: 'Guest' }),       // exception
    member('u3', { active: false }),       // exception
    member('u4', { role: 'Admin' }),       // exception
    member('u5'),                          // routine, decided below
    member('u6', { role: 'Owner' })        // exception
  ];
  const ch = makeChannel(members, { u5: { decision: 'keep' } });

  assert.deepEqual(filterRoster(ch, 'todo').map(m => m.id), ['u1', 'u2', 'u3', 'u4', 'u6']);
  assert.deepEqual(filterRoster(ch, 'attention').map(m => m.id), ['u2', 'u3', 'u4', 'u6']);
  assert.equal(filterRoster(ch, 'all').length, 6);
});

test('clampPageSize accepts allowed sizes and falls back to default', () => {
  assert.equal(clampPageSize(10), 10);
  assert.equal(clampPageSize(25), 25);
  assert.equal(clampPageSize(50), 50);
  assert.equal(clampPageSize(7), DEFAULT_PAGE_SIZE);
  assert.equal(clampPageSize(999), DEFAULT_PAGE_SIZE);
  assert.equal(clampPageSize('25'), 25);
  assert.equal(clampPageSize(undefined), DEFAULT_PAGE_SIZE);
});

test('paginate slices and clamps the page index', () => {
  const items = Array.from({ length: 25 }, (_, i) => i);
  const first = paginate(items, 0, 10);
  assert.equal(first.slice.length, 10);
  assert.equal(first.pages, 3);
  assert.equal(first.page, 0);
  assert.equal(first.start, 0);
  assert.equal(first.end, 10);

  const overflow = paginate(items, 9, 10); // page 9 clamps to last (2)
  assert.equal(overflow.page, 2);
  assert.equal(overflow.slice.length, 5);
  assert.equal(overflow.end, 25);

  const empty = paginate([], 3, 25);
  assert.equal(empty.slice.length, 0);
  assert.equal(empty.pages, 1);
  assert.equal(empty.page, 0);
});

// ── view builders ────────────────────────────────────────────────────────────

function checkboxOptions(view) {
  let opts = [];
  for (const b of view.blocks) {
    if (b.type === 'actions') {
      for (const el of b.elements) if (el.type === 'checkboxes') opts = opts.concat(el.options);
    }
  }
  return opts;
}

function checkboxGroups(view) {
  const groups = [];
  for (const b of view.blocks) {
    if (b.type === 'actions') {
      for (const el of b.elements) if (el.type === 'checkboxes') groups.push(el.options.length);
    }
  }
  return groups;
}

test('buildReviewRosterView respects page size and chunks checkboxes at 10', () => {
  const members = Array.from({ length: 25 }, (_, i) => member('u' + i));
  const campaign = { id: 'c1', name: 'Q3 review', dueDate: '2099-01-01', scope: 'all', status: 'active', channels: [makeChannel(members)] };
  const channel = campaign.channels[0];

  const p10 = buildReviewRosterView({ campaign, channel, userId: 'U_me', isAdmin: true, page: 0, pageSize: 10, filter: 'all' });
  assert.equal(p10.type, 'home');
  assert.equal(checkboxOptions(p10).length, 10, 'page of 10 shows 10 checkboxes');
  assert.equal(JSON.parse(p10.private_metadata).ps, 10);

  const p25 = buildReviewRosterView({ campaign, channel, userId: 'U_me', isAdmin: true, page: 0, pageSize: 25, filter: 'all' });
  assert.equal(checkboxOptions(p25).length, 25, 'page of 25 shows 25 checkboxes');
  assert.deepEqual(checkboxGroups(p25), [10, 10, 5], 'checkbox groups never exceed 10 options');
});

test('buildReviewRosterView shows the completion message when nothing is left to review', () => {
  const members = [member('a'), member('b')];
  const channel = makeChannel(members, { a: { decision: 'keep' }, b: { decision: 'remove' } });
  const campaign = { id: 'c1', name: 'Q3', dueDate: '2099-01-01', scope: 'all', status: 'active', channels: [channel] };
  const view = buildReviewRosterView({ campaign, channel, userId: 'U_me', isAdmin: true, filter: 'todo' });
  const text = JSON.stringify(view.blocks);
  assert.match(text, /has been reviewed/);
  assert.equal(checkboxOptions(view).length, 0);
});

test('buildReviewIndexView scopes channels to the reviewer unless admin', () => {
  const chMine = makeChannel([member('a')], {}, { id: 'C_mine', name: 'mine', reviewerId: 'U_me' });
  const chOther = makeChannel([member('b')], {}, { id: 'C_other', name: 'other', reviewerId: 'U_other' });
  const campaign = { id: 'c1', name: 'Q3', dueDate: '2099-01-01', scope: 'all', status: 'active', channels: [chMine, chOther] };

  const reviewerView = JSON.stringify(buildReviewIndexView({ campaign, userId: 'U_me', isAdmin: false }).blocks);
  assert.match(reviewerView, /#mine/);
  assert.doesNotMatch(reviewerView, /#other/);

  const adminView = JSON.stringify(buildReviewIndexView({ campaign, userId: 'U_me', isAdmin: true }).blocks);
  assert.match(adminView, /#mine/);
  assert.match(adminView, /#other/);
});
