require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const crypto = require('crypto');
const { handleEvent } = require('./handlers/eventHandler');
const { handleAction } = require('./handlers/actionHandler');
const { handleViewSubmission } = require('./handlers/viewSubmissionHandler');
const { logInfo, logError } = require('./utils/logger');
const { verifyAllChains, findIncompleteRevocations } = require('./services/auditService');

const app = express();

app.use(bodyParser.json({
  verify: (req, res, buf) => { req.rawBody = buf.toString('utf8'); }
}));
// Capture the raw body for urlencoded requests too — Slack sends interactivity
// (button clicks / modals) as application/x-www-form-urlencoded, and signature
// verification needs the exact raw bytes. Without this, actions return 401.
app.use(bodyParser.urlencoded({
  extended: true,
  verify: (req, res, buf) => { req.rawBody = buf.toString('utf8'); }
}));

app.get('/health', (req, res) => {
  res.json({ status: 'healthy', timestamp: new Date().toISOString(), mode: 'stateless' });
});

function verifySignature(req) {
  // Slack signatures are ALWAYS verified. There is no environment bypass:
  // a missing/invalid signature is rejected in every environment.
  const timestamp = req.headers['x-slack-request-timestamp'];
  const signature = req.headers['x-slack-signature'];
  if (!timestamp || !signature) return false;
  if (Math.abs(Date.now() / 1000 - timestamp) > 300) return false;
  const sigBasestring = 'v0:' + timestamp + ':' + req.rawBody;
  const mySignature = 'v0=' + crypto
    .createHmac('sha256', process.env.SLACK_SIGNING_SECRET)
    .update(sigBasestring)
    .digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(mySignature));
  } catch (e) { return false; }
}

// EVENTS - ack immediately, process async
app.post('/slack/events', async (req, res) => {
  if (req.body.type === 'url_verification') {
    return res.json({ challenge: req.body.challenge });
  }
  if (!verifySignature(req)) return res.sendStatus(401);
  res.sendStatus(200); // ack first
  handleEvent(req.body).catch(err => logError('Event error:', err));
});

// ACTIONS (button clicks) - ack immediately, process async
app.post('/slack/actions', async (req, res) => {
  if (!verifySignature(req)) return res.sendStatus(401);

  let payload;
  try {
    payload = JSON.parse(req.body.payload);
  } catch (e) {
    return res.sendStatus(400);
  }

  // VIEW SUBMISSIONS need synchronous response (push/clear/errors)
  // Must respond within 3 seconds WITH the response body
  if (payload.type === 'view_submission') {
    try {
      const response = await handleViewSubmission(payload);
      if (response) {
        // Return the action response (push modal, clear, errors)
        return res.json(response);
      }
      return res.sendStatus(200);
    } catch (error) {
      logError('View submission error:', error);
      return res.sendStatus(200);
    }
  }

  // All other interactions (button clicks, checkboxes) - ack immediately
  res.sendStatus(200);
  handleAction(payload).catch(err => logError('Action error:', err));
});

app.use((err, req, res, next) => {
  logError('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// Fail closed in production if the request-authenticity secret is missing (M5):
// without it, Slack signature verification cannot be enforced.
if (process.env.NODE_ENV === 'production' && !process.env.SLACK_SIGNING_SECRET) {
  throw new Error('SLACK_SIGNING_SECRET is required in production (cannot verify Slack requests without it)');
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  logInfo('Server running on port ' + PORT);
  logInfo('Stateless mode - Zero persistent storage');
  logInfo('Slack signing secret: ' + (process.env.SLACK_SIGNING_SECRET ? 'Configured' : 'MISSING'));
  logInfo('Slack bot token: ' + (process.env.SLACK_BOT_TOKEN ? 'Configured' : 'MISSING'));
});

// Audit integrity: verify the tamper-evident chain and surface any revocation
// that was initiated but never completed (R7/R9). Runs at boot and periodically.
async function runAuditIntegrityCheck() {
  try {
    const chain = await verifyAllChains();
    if (chain.ok) logInfo(`Audit chain OK: ${chain.count} entries across ${chain.files} file(s)`);
    else logError(`AUDIT CHAIN BROKEN in ${chain.file} at #${chain.brokenAt}: ${chain.reason}`);
  } catch (e) { logError('Audit chain verify failed:', e.message); }
  try {
    const incomplete = await findIncompleteRevocations();
    if (incomplete.length) {
      logError(`${incomplete.length} revocation(s) initiated but never completed:`,
        incomplete.map(i => (i.target && i.target.userName) || i.idempotencyKey).join(', '));
    }
  } catch (e) { logError('Reconciliation check failed:', e.message); }
}
runAuditIntegrityCheck();

const AUDIT_VERIFY_INTERVAL_MS = Number(process.env.AUDIT_VERIFY_INTERVAL_MS || 6 * 60 * 60 * 1000);
if (AUDIT_VERIFY_INTERVAL_MS > 0) {
  setInterval(runAuditIntegrityCheck, AUDIT_VERIFY_INTERVAL_MS).unref();
}
