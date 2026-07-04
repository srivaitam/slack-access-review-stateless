// exportService pulls in the Slack client transitively; give it a token.
process.env.SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN || 'xoxb-test-dummy';

const test = require('node:test');
const assert = require('node:assert');
const { csvEscape } = require('../services/exportService');

test('csvEscape neutralizes spreadsheet formula-injection prefixes (M1)', () => {
  for (const bad of ['=1+1', '+x', '-x', '@SUM(A1)', '\ttab', '\rcr']) {
    assert.equal(csvEscape(bad)[0], "'", `expected quote prefix for ${JSON.stringify(bad)}`);
  }
  assert.equal(csvEscape('normal'), 'normal');
  assert.equal(csvEscape('a,b'), '"a,b"');
  assert.equal(csvEscape('he said "hi"'), '"he said ""hi"""');
  assert.equal(csvEscape(null), '');
});
