# Slack Access Review - Stateless Architecture

A stateless Slack access-governance tool: no application database and no raw message content retained. A minimal, tamper-evident audit trail (actions plus actor/target emails) is written to disk and can optionally be forwarded to an external sink.

## 🎯 Key Features

- ✅ **Zero Database** - All data fetched on-demand from Slack API
- ✅ **Real-time Access View** - Always fresh data
- ✅ **Risk Scoring** - Automated channel and user risk assessment
- ✅ **Access Revocation** - Remove users from channels with audit trail
- ✅ **Tamper-evident Audit** - HMAC-chained, file-based audit logs (SOX/ISO27001-friendly), with optional off-host forwarding
- ✅ **Minimal Retention** - No application database; only a minimal governance audit trail (actions + actor/target emails) is persisted — no raw message content

## ⚙️ Configuration

Set via environment variables (copy `.env.example` to `.env`):

| Variable | Purpose | Default |
|---|---|---|
| `SLACK_BOT_TOKEN` | Bot token (**required**) | — |
| `SLACK_SIGNING_SECRET` | Request signature verification (**required**) | — |
| `AUDIT_HMAC_SECRET` | Secret keying the tamper-evident audit chain (**required in production**) | dev-only fallback |
| `AUDIT_WEBHOOK_URL` | Optional URL each audit entry is POSTed to (durable off-host sink) | — |
| `INTERNAL_EMAIL_DOMAINS` | Comma-separated domains treated as internal for risk scoring | majority domain |
| `RISK_WEIGHTS` | JSON overriding the risk-scoring weights | built-in defaults |
| `SLACK_TIMEOUT_MS` | Per-call Slack API timeout | 15000 |
| `SNAPSHOT_TTL_MS` | Access-snapshot cache lifetime | 60000 |
| `MAX_CONCURRENT_API_CALLS` | Channel-membership fan-out concurrency | 10 |
| `SLACK_MAX_CONCURRENCY` | Global cap on concurrent Slack API calls | 10 |
| `SLACK_TIER2_PER_MIN` / `SLACK_TIER3_PER_MIN` / `SLACK_TIER4_PER_MIN` | Rate-limit reservoirs per Slack tier (raise for large workspaces) | 20 / 50 / 100 |
| `AUDIT_VERIFY_INTERVAL_MS` | How often to re-verify the audit chain (0 disables) | 21600000 (6h) |

> **Security:** never commit real secrets (`.env` is gitignored). Rotate the bot token + signing secret immediately if they were ever committed.

## 📋 Prerequisites

- Node.js >= 18.0.0
- Slack workspace with admin access
- Slack app with required permissions

## 🚀 Quick Start

### 1. Clone & Install

```bash
cd slack-access-review-stateless
npm install
```

### 2. Create Slack App

1. Go to https://api.slack.com/apps
2. Click "Create New App" → "From scratch"
3. Name: "Access Review"
4. Choose your workspace

### 3. Configure Permissions (OAuth & Permissions)

Add these **Bot Token Scopes**:

```
channels:read
channels:manage
groups:read
groups:write
users:read
users:read.email
chat:write
im:write
files:write
```

### 4. Enable Events

1. Go to "Event Subscriptions"
2. Enable Events
3. Request URL: `https://your-domain.com/slack/events`
4. Subscribe to bot events:
   - `app_home_opened`
   - `app_uninstalled` (multi-workspace mode: cleans up that workspace's token + data)
   - `tokens_revoked`

### 5. Enable Interactivity

1. Go to "Interactivity & Shortcuts"
2. Enable Interactivity
3. Request URL: `https://your-domain.com/slack/actions`

### 6. Configure App Home

1. Go to "App Home"
2. Enable "Home Tab"
3. Enable "Messages Tab"

### 7. Install App to Workspace

**Single workspace (legacy):**
1. Go to "Install App"
2. Click "Install to Workspace"
3. Copy the "Bot User OAuth Token" → `SLACK_BOT_TOKEN`

**Multi-workspace public distribution (OAuth):**
1. Basic Information → App Credentials → copy Client ID + Client Secret → `SLACK_CLIENT_ID` / `SLACK_CLIENT_SECRET`
2. OAuth & Permissions → Redirect URLs → add `https://your-domain.com/slack/oauth/callback`
3. Set `DATABASE_URL`, `TOKEN_ENCRYPTION_KEY`, `PUBLIC_BASE_URL` (see `.env.example` / `render.yaml`)
4. Manage Distribution → complete the checklist → **Activate Public Distribution**
5. Share the install link: `https://your-domain.com/slack/install` — any workspace can now install.
   Per-workspace bot tokens are stored AES-256-GCM-encrypted in Postgres; campaigns and the
   tamper-evident audit chain are stored per `team_id`. No messages or live workspace data are
   ever persisted — snapshots are fetched from Slack's API on demand.

### 8. Setup Environment

```bash
cp .env.example .env
```

Edit `.env` and add your tokens:

```env
SLACK_BOT_TOKEN=xoxb-your-actual-token
SLACK_SIGNING_SECRET=your-actual-secret
PORT=3000
```

### 9. Run the App

```bash
# Development mode with auto-reload
npm run dev

# Production mode
npm start
```

### 10. Expose to Internet (Development)

Use ngrok for local development:

```bash
ngrok http 3000
```

Update your Slack app's Request URLs with the ngrok URL.

## 📁 Project Structure

```
slack-access-review-stateless/
├── index.js                      # Main Express server
├── config/
│   └── constants.js              # Configuration
├── slack/
│   ├── client.js                 # Slack WebClient
│   ├── users.js                  # Fetch users
│   ├── channels.js               # Fetch channels
│   ├── channelMembers.js         # Fetch members
│   └── rateLimiter.js            # Rate limit handling
├── services/
│   ├── accessService.js          # Access data aggregation
│   ├── riskScoringService.js     # Risk calculation
│   ├── revocationService.js      # Access revocation
│   ├── auditService.js           # Audit logging
│   └── notificationService.js    # Slack notifications
├── views/
│   ├── homeView.js               # App Home overview
│   ├── usersAccessView.js        # Users dashboard
│   ├── channelsAccessView.js     # Channels dashboard
│   ├── highRiskView.js           # High-risk view
│   └── loadingView.js            # Loading states
├── modals/
│   ├── userAccessModal.js        # User details
│   ├── channelAccessModal.js     # Channel details
│   ├── revocationConfirmModal.js # Revoke confirmation
│   └── bulkRevocationModal.js    # Bulk operations
├── handlers/
│   ├── eventHandler.js           # Event processing
│   ├── actionHandler.js          # Button/action handling
│   └── viewSubmissionHandler.js  # Modal submissions
└── utils/
    ├── logger.js                 # Logging
    ├── errorHandler.js           # Error handling
    └── slackVerification.js      # Request verification
```

## 🔐 Security Features

- ✅ Slack request signature verification
- ✅ Role-based access (only admins can revoke)
- ✅ Audit logging for all actions
- ✅ Reason required for revocations
- ✅ User notification on access changes

## 📊 How It Works

1. **User opens App Home** → Triggers data fetch
2. **Fetch from Slack API**:
   - All users (filtered to humans)
   - All channels (public + private)
   - Members for each channel
3. **Calculate risk scores** (on-the-fly)
4. **Render UI** with access details
5. **User navigates away** → All data discarded
6. **Next visit** → Fresh fetch from Slack

## 🎯 Risk Scoring

Channels are scored 0-100 based on:

- **External users** (30% weight)
- **Guest users** (25% weight)
- **Privileged users** (20% weight)
- **Inactive users** (15% weight)
- **Sensitive keywords** (10% weight)

## 📝 Audit Logs

All revocation actions are logged to:
```
audit-logs/audit-YYYY-MM.jsonl
```

Format: JSON Lines (one event per line)

## 🚨 Rate Limits

The app respects Slack's rate limits:
- Tier 2: 20 requests/minute (users, channels)
- Tier 3: 50 requests/minute (channel members)

Large workspaces may take 5-30 minutes to load initially.

## 🔧 Troubleshooting

### "Missing scopes" error
- Reinstall the app to workspace after adding new scopes

### "Channel not found" errors
- Bot must be added to private channels to see members
- Expected behavior for channels bot can't access

### Slow loading
- Normal for large workspaces (1000+ channels)
- Consider implementing caching if needed

## 📈 Scaling Considerations

**Current architecture works for:**
- Small: <500 users, <100 channels (30-60 sec load)
- Medium: 500-2000 users, 100-500 channels (2-10 min load)

**For larger workspaces:**
- Consider adding Redis caching (15-min TTL)
- Implement background sync jobs
- See [SCALING.md](./SCALING.md) for guidance

## 🤝 Contributing

This is a stateless reference implementation. Fork and customize for your needs!

## 📄 License

MIT License - See LICENSE file

## 🆘 Support

For issues or questions, open a GitHub issue.

---

**Built with ❤️ for enterprise access governance**
