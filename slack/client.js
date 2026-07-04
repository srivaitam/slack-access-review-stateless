const { WebClient } = require('@slack/web-api');

if (!process.env.SLACK_BOT_TOKEN) {
  throw new Error('SLACK_BOT_TOKEN is required');
}

const slack = new WebClient(process.env.SLACK_BOT_TOKEN, {
  retryConfig: { retries: 3, factor: 2 },
  timeout: Number(process.env.SLACK_TIMEOUT_MS || 15000), // M4: bound each call
  maxRequestConcurrency: Number(process.env.SLACK_MAX_CONCURRENCY || 10) // R3: global cap on all calls (incl. writes)
});

module.exports = { slack };
