'use strict';

const crypto = require('crypto');
const { logWarn } = require('./logger');

const MAX_TIMESTAMP_SKEW_SECONDS = 60 * 5; // 5 min, per Slack docs

/**
 * Express middleware that verifies Slack request signatures.
 * Requires req.rawBody (set by the body-parser `verify` hook in index.js).
 *
 * Set ALLOW_UNVERIFIED_SLACK_REQUESTS=true to skip in local dev ONLY.
 * NODE_ENV is intentionally NOT used as a bypass switch.
 */
function verifySlackRequest(req, res, next) {
  const signingSecret = process.env.SLACK_SIGNING_SECRET;

  if (!signingSecret) {
    logWarn('SLACK_SIGNING_SECRET is not set - refusing request');
    return res.status(500).send('Server misconfigured');
  }

  if (process.env.ALLOW_UNVERIFIED_SLACK_REQUESTS === 'true') {
    logWarn('Signature verification BYPASSED via ALLOW_UNVERIFIED_SLACK_REQUESTS');
    return next();
  }

  const timestamp = req.headers['x-slack-request-timestamp'];
  const signature = req.headers['x-slack-signature'];

  if (!timestamp || !signature) {
    return res.status(401).send('Unauthorized');
  }

  const skew = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (!Number.isFinite(skew) || skew > MAX_TIMESTAMP_SKEW_SECONDS) {
    return res.status(401).send('Request too old');
  }

  if (typeof req.rawBody !== 'string') {
    return res.status(400).send('Missing raw body');
  }

  const sigBasestring = 'v0:' + timestamp + ':' + req.rawBody;
  const mySignature = 'v0=' + crypto
    .createHmac('sha256', signingSecret)
    .update(sigBasestring)
    .digest('hex');

  const a = Buffer.from(signature, 'utf8');
  const b = Buffer.from(mySignature, 'utf8');
  if (a.length !== b.length) {
    return res.status(401).send('Invalid signature');
  }

  try {
    if (crypto.timingSafeEqual(a, b)) return next();
    return res.status(401).send('Invalid signature');
  } catch (err) {
    return res.status(401).send('Signature verification failed');
  }
}

module.exports = { verifySlackRequest, MAX_TIMESTAMP_SKEW_SECONDS };
