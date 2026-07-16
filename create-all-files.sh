#!/bin/bash

# Slack Client Files
cat > slack/client.js << 'EOF'
const { WebClient } = require('@slack/web-api');

if (!process.env.SLACK_BOT_TOKEN) {
  throw new Error('SLACK_BOT_TOKEN is required');
}

const slack = new WebClient(process.env.SLACK_BOT_TOKEN, {
  retryConfig: { retries: 3, factor: 2 }
});

module.exports = { slack };
EOF

cat > slack/users.js << 'EOF'
const { slack } = require('./client');

async function getAllUsers() {
  const result = await slack.users.list({ limit: 1000 });
  return result.members
    .filter(u => !u.is_bot && !u.is_app_user && u.id !== 'USLACKBOT' && u.profile?.email)
    .map(u => ({
      id: u.id,
      name: u.profile.real_name || u.name,
      email: u.profile.email,
      role: u.is_owner ? 'Owner' : u.is_admin ? 'Admin' : 'Member',
      active: !u.deleted,
      is_owner: u.is_owner || false,
      is_admin: u.is_admin || false
    }));
}

module.exports = { getAllUsers };
EOF

cat > slack/channels.js << 'EOF'
const { slack } = require('./client');

async function getAllChannels() {
  const result = await slack.conversations.list({
    types: 'public_channel,private_channel',
    exclude_archived: true,
    limit: 1000
  });
  return result.channels.map(c => ({
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
EOF

cat > slack/channelMembers.js << 'EOF'
const { slack } = require('./client');

async function getChannelMembers(channelId) {
  try {
    const result = await slack.conversations.members({ channel: channelId, limit: 1000 });
    return result.members || [];
  } catch (error) {
    if (error.data?.error === 'channel_not_found' || error.data?.error === 'not_in_channel') {
      return [];
    }
    throw error;
  }
}

module.exports = { getChannelMembers };
EOF

cat > slack/rateLimiter.js << 'EOF'
const Bottleneck = require('bottleneck');

const limiters = {
  tier2: new Bottleneck({ reservoir: 20, reservoirRefreshAmount: 20, reservoirRefreshInterval: 60000, maxConcurrent: 5 }),
  tier3: new Bottleneck({ reservoir: 50, reservoirRefreshAmount: 50, reservoirRefreshInterval: 60000, maxConcurrent: 10 })
};

function withRateLimit(tier, fn) {
  return limiters[tier].wrap(fn);
}

module.exports = { withRateLimit, limiters };
EOF

echo "✅ Slack files created"

# Utils
cat > utils/logger.js << 'EOF'
function logInfo(...args) {
  console.log('[INFO]', new Date().toISOString(), ...args);
}

function logError(...args) {
  console.error('[ERROR]', new Date().toISOString(), ...args);
}

function logWarn(...args) {
  console.warn('[WARN]', new Date().toISOString(), ...args);
}

module.exports = { logInfo, logError, logWarn };
EOF

cat > utils/slackVerification.js << 'EOF'
const crypto = require('crypto');

function verifySlackRequest(req, res, next) {
  if (process.env.NODE_ENV === 'development') {
    return next(); // Skip in dev
  }

  const timestamp = req.headers['x-slack-request-timestamp'];
  const signature = req.headers['x-slack-signature'];
  
  if (!timestamp || !signature) {
    return res.status(401).send('Unauthorized');
  }

  const timeDiff = Math.abs(Date.now() / 1000 - timestamp);
  if (timeDiff > 300) {
    return res.status(401).send('Request too old');
  }

  const sigBasestring = \`v0:\${timestamp}:\${req.rawBody}\`;
  const mySignature = 'v0=' + crypto
    .createHmac('sha256', process.env.SLACK_SIGNING_SECRET)
    .update(sigBasestring)
    .digest('hex');

  if (crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(mySignature))) {
    next();
  } else {
    res.status(401).send('Invalid signature');
  }
}

module.exports = { verifySlackRequest };
EOF

cat > utils/errorHandler.js << 'EOF'
function handleError(error, context = '') {
  console.error(\`[ERROR] \${context}:\`, error.message);
  if (error.stack) {
    console.error(error.stack);
  }
}

module.exports = { handleError };
EOF

echo "✅ Utils created"

echo "🎉 Core files created! Now run the full application generator..."

