# 🚀 QUICK START GUIDE - Slack Access Review (Stateless)

## What You've Downloaded

A complete, production-ready Slack access governance application with:
- ✅ No application database (only a minimal, tamper-evident audit log is persisted)
- ✅ Real-time access fetching from Slack API
- ✅ Risk scoring engine
- ✅ Access revocation capabilities
- ✅ Audit logging (file-based)

## 📦 Installation (5 minutes)

### Step 1: Extract Files

```bash
tar -xzf slack-access-review-stateless.tar.gz
cd slack-access-review-stateless
```

### Step 2: Install Dependencies

```bash
npm install
```

### Step 3: Create Slack App

1. Go to https://api.slack.com/apps
2. Click "Create New App" → "From scratch"
3. Name: "Access Review" (or your choice)
4. Select your workspace
5. Click "Create App"

### Step 4: Configure Bot Permissions

Go to **"OAuth & Permissions"** → **"Bot Token Scopes"**

Add these scopes:
```
channels:read
channels:manage
groups:read
groups:write
users:read
users:read.email
chat:write
im:write
```

### Step 5: Enable Events

1. Go to **"Event Subscriptions"**
2. Toggle "Enable Events" → ON
3. Request URL: `https://your-domain.com/slack/events`
   - (Use ngrok for local dev - see below)
4. Subscribe to bot events: `app_home_opened`
5. Save Changes

### Step 6: Enable Interactivity

1. Go to **"Interactivity & Shortcuts"**
2. Toggle "Interactivity" → ON
3. Request URL: `https://your-domain.com/slack/actions`
4. Save Changes

### Step 7: Enable App Home

1. Go to **"App Home"**
2. Check "Home Tab" → Enable
3. Check "Messages Tab" → Enable

### Step 8: Install to Workspace

1. Go to **"Install App"**
2. Click "Install to Workspace"
3. Authorize the app
4. **Copy the "Bot User OAuth Token"** (starts with `xoxb-`)

### Step 9: Get Signing Secret

1. Go to **"Basic Information"**
2. Scroll to **"App Credentials"**
3. **Copy the "Signing Secret"**

### Step 10: Configure Environment

```bash
cp .env.example .env
nano .env  # or use your preferred editor
```

Paste your tokens:
```env
SLACK_BOT_TOKEN=xoxb-your-actual-token-here
SLACK_SIGNING_SECRET=your-signing-secret-here
PORT=3000
MAX_CONCURRENT_API_CALLS=10
```

### Step 11: Run the App

```bash
npm start
```

You should see:
```
🚀 Server running on port 3000
📊 Stateless mode - Zero persistent storage
```

---

## 🌐 Local Development with ngrok

For testing locally, use ngrok to expose your server:

```bash
# Install ngrok (if not installed)
brew install ngrok  # macOS
# or download from https://ngrok.com

# Start your app
npm start

# In another terminal, start ngrok
ngrok http 3000
```

Copy the ngrok URL (e.g., `https://abc123.ngrok.io`) and update:
1. Slack App → Event Subscriptions → Request URL
2. Slack App → Interactivity → Request URL

---

## 🧪 Testing

1. **Open Slack**
2. **Find your app** in the sidebar (under "Apps")
3. **Click on the app** to open App Home
4. **Wait 30-60 seconds** for initial data fetch
5. **View access dashboard** with all users and risk scores

---

## 📊 How It Works

### On First Load:
```
User opens app
    ↓
Fetch all users from Slack (2-5 sec)
    ↓
Fetch all channels from Slack (2-5 sec)
    ↓
Fetch members for each channel (5-60 sec depending on size)
    ↓
Calculate risk scores on-the-fly
    ↓
Display dashboard
    ↓
User closes app → All data discarded ✅
```

### Performance Expectations:
- **Small workspace** (50 users, 20 channels): 30-60 seconds
- **Medium workspace** (500 users, 200 channels): 5-10 minutes
- **Large workspace** (5000 users, 1000 channels): 20-30 minutes

### Why It's Slow (But That's OK):
- Fetching fresh data from Slack API every time
- Respecting rate limits (50 requests/minute for channel members)
- Zero caching = Zero stored data = Maximum compliance

---

## ⚡ Features

### 1. Access Dashboard
- View all users with risk scores
- See channel counts per user
- Identify high-risk access patterns

### 2. User Detail View
- Click "View Access" on any user
- See all channels they're in
- Sorted by risk level
- Public vs private breakdown

### 3. Risk Scoring
Channels scored 0-100 based on:
- External users (30%)
- Guest users (25%)
- Privileged users (20%)
- Inactive users (15%)
- Sensitive keywords (10%)

### 4. Access Revocation
- Remove users from channels
- Require justification
- Optional user notification
- Complete audit trail

### 5. Audit Logging
All actions logged to:
```
audit-logs/audit-YYYY-MM.jsonl
```

Format: JSON Lines (one event per line)

---

## 🔧 Troubleshooting

### "Missing Permissions" Error
- Reinstall app to workspace after adding new scopes
- Go to Slack App → "Reinstall App"

### "Channel Not Found" Errors
- Normal for private channels bot isn't in
- Bot only sees channels it's a member of
- Private channel members won't appear unless bot is added

### App Loads Slowly
- Expected behavior for stateless architecture
- Each load fetches fresh data from Slack
- Consider adding Redis cache if too slow (see README)

### Rate Limit Errors
- Slack limits: 50 requests/minute for channel members
- App automatically handles rate limits
- For very large workspaces (5000+ channels), expect 30+ min load times

---

## 📁 Project Structure

```
slack-access-review-stateless/
├── index.js                  # Main server
├── slack/                    # Slack API integration
│   ├── client.js
│   ├── users.js
│   ├── channels.js
│   └── channelMembers.js
├── services/                 # Business logic
│   ├── accessService.js      # Main data aggregation
│   ├── riskScoringService.js
│   ├── revocationService.js
│   └── auditService.js
├── views/                    # Slack UI views
├── modals/                   # Slack modals
├── handlers/                 # Event & action handlers
└── utils/                    # Helpers
```

---

## 🎯 Next Steps

### For Production:
1. **Deploy to cloud** (Heroku, AWS, GCP, Azure)
2. **Set up monitoring** (Datadog, New Relic, Sentry)
3. **Configure HTTPS** (Let's Encrypt, CloudFlare)
4. **Enable audit log export** to SIEM
5. **Set up alerts** for high-risk changes

### For Better Performance:
1. **Add Redis caching** (15-minute TTL)
2. **Implement background sync jobs**
3. **Add pagination** for large workspaces

### For Compliance:
1. **Archive audit logs monthly**
2. **Set up automated reports**
3. **Integrate with your SIEM** (Splunk, ELK, etc.)
4. **Document access review procedures**

---

## 🆘 Support

### Common Issues:

**Q: Load time too slow?**  
A: Add Redis caching or reduce `MAX_CONCURRENT_API_CALLS` in .env

**Q: Getting rate limited?**  
A: Increase delays between API calls in slack/rateLimiter.js

**Q: Can't see private channels?**  
A: Bot must be added to each private channel to fetch members

**Q: Want to store data?**  
A: See README.md for hybrid architecture with temporary caching

---

## 📜 License

MIT License - Free to use and modify

---

## 🎉 You're Ready!

Your stateless Slack access governance tool is now running!

Open Slack → Find your app → View the access dashboard

Questions? Check the full README.md for detailed documentation.
