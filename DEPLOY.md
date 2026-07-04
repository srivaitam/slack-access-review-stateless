# Deploying to Render — step by step

Plain-language guide to putting this Slack Access Review app into production on [Render](https://render.com).

## What you're deploying (and what you're NOT)

This app is a single Node.js web server. It listens for two kinds of web requests from Slack (events and button clicks) and talks back to Slack.

- **You need exactly one Render service:** a **Web Service** (Node).
- **You do NOT need a database or Redis.** The app keeps no application database — it reads everything from Slack live.
- **One catch — the audit log.** The app writes a tamper-evident audit log to a file. Render erases a service's normal disk on every deploy, so to keep those logs you attach **one Persistent Disk**. (Alternative: set `AUDIT_WEBHOOK_URL` to forward the log somewhere else and skip the disk.)

So the whole production footprint is: **1 Web Service + 1 small Disk.** That's it.

---

## Step 0 — Before you touch Render

1. **Put the code on GitHub (or GitLab).** Render deploys from a Git repo. Make the folder that contains `package.json` the root of the repo. For example:
   ```bash
   cd slack-access-review-stateless
   git init
   git add .
   git commit -m "Slack Access Review"
   git branch -M main
   git remote add origin https://github.com/<you>/slack-access-review.git
   git push -u origin main
   ```
2. **Rotate your Slack secrets.** The old bot token and signing secret were committed earlier, so treat them as compromised. In <https://api.slack.com/apps> → your app: regenerate the **Signing Secret** (Basic Information) and reinstall to get a fresh **Bot Token** (OAuth & Permissions). Keep both handy.
3. **Have an audit secret ready** (Render can generate this for you in Step 1B, or make your own): `openssl rand -hex 32`.

---

## Step 1 — Create the Web Service

You can do this the easy way (Blueprint) or the manual way. Both give the same result.

### Option A — Blueprint (uses the included `render.yaml`, recommended)

1. Commit the `render.yaml` file in this folder to your repo.
2. In Render: **New +** → **Blueprint** → pick your repo.
3. Render reads `render.yaml` and shows the service + disk it will create. It will ask you to fill in the two secrets marked "sync: false": `SLACK_BOT_TOKEN` and `SLACK_SIGNING_SECRET`. Paste your rotated values.
4. Click **Apply**. Render builds and deploys.

### Option B — Manual (click-through dashboard)

1. In Render: **New +** → **Web Service** → connect your Git repo.
2. Fill in:
   - **Root Directory:** leave blank if `package.json` is at the repo root (otherwise the subfolder that contains it, e.g. `slack-access-review-stateless`).
   - **Language / Runtime:** Node
   - **Build Command:** `npm ci`
   - **Start Command:** `npm start`
   - **Instance Type:** **Starter** (always-on, recommended). *Free* works for testing but sleeps after 15 minutes idle — see the Cold-start note.
3. Open **Advanced** and set **Health Check Path** to `/health`.
4. Add a disk: **Advanced → Add Disk** → Name `audit-logs`, Mount Path `/var/data`, Size `1 GB`.
5. Add the environment variables from Step 2, then **Create Web Service**.

> **Do not set `PORT`.** Render provides it automatically and the app already reads it.

---

## Step 2 — Environment variables

Set these in the service's **Environment** tab (Blueprint users: most are already there; just paste the two secrets).

**Required**

| Key | Value |
|---|---|
| `NODE_ENV` | `production` |
| `SLACK_BOT_TOKEN` | your rotated bot token (`xoxb-…`) |
| `SLACK_SIGNING_SECRET` | your rotated signing secret |
| `AUDIT_HMAC_SECRET` | a long random string (or use Render's **Generate**) |
| `AUDIT_LOG_DIR` | `/var/data/audit-logs` (so the log lands on the disk) |

**Optional** (safe to leave unset)

| Key | What it does |
|---|---|
| `AUDIT_WEBHOOK_URL` | Forward each audit entry to an external log/SIEM (use this instead of a disk if you prefer) |
| `INTERNAL_EMAIL_DOMAINS` | Comma-separated domains treated as "internal" for risk scoring (else the majority domain) |
| `RISK_WEIGHTS` | JSON to tune the risk-scoring weights |
| `SLACK_TIMEOUT_MS` | Per-call Slack timeout (default 15000) |
| `SNAPSHOT_TTL_MS` | How long a scan is cached (default 60000) |
| `SLACK_MAX_CONCURRENCY`, `SLACK_TIER2_PER_MIN`, `SLACK_TIER3_PER_MIN`, `SLACK_TIER4_PER_MIN` | Rate-limit tuning for large workspaces |
| `AUDIT_VERIFY_INTERVAL_MS` | How often to re-verify the audit chain (default 6h; 0 disables) |

---

## Step 3 — Deploy and verify

1. Wait for the service to show **Live**.
2. Test the health endpoint: open `https://<your-app>.onrender.com/health` — you should see `{"status":"healthy",...}`.
3. Copy your service URL (`https://<your-app>.onrender.com`). You'll need it next.

---

## Step 4 — Point Slack at your Render URL

In <https://api.slack.com/apps> → your app:

1. **Event Subscriptions** → turn on → **Request URL:** `https://<your-app>.onrender.com/slack/events`. Slack sends a quick verification; it should turn green. Then under **Subscribe to bot events** add `app_home_opened`. Save.
2. **Interactivity & Shortcuts** → turn on → **Request URL:** `https://<your-app>.onrender.com/slack/actions`. Save.
3. **App Home** → enable the **Home Tab**.
4. If you changed scopes or reinstalled, **reinstall the app** to your workspace.

That's the whole wiring. Open your app's **Home** tab in Slack — an admin should see the dashboard; a non-admin sees the "admins only" screen.

---

## Notes worth knowing

- **Cold starts (Free tier):** a Free service sleeps after ~15 min idle and takes ~50s to wake. Slack expects a reply within 3 seconds, so the first request after sleeping can fail Slack's checks. For anything real, use the **Starter** instance (always-on).
- **Why the disk matters:** it's the only place your compliance audit trail survives a redeploy. If you'd rather not run a disk, set `AUDIT_WEBHOOK_URL` and the app streams every audit entry off-host instead.
- **Self-check on boot:** on startup (and every 6h) the app verifies the audit chain and logs a loud error if anything was tampered with, plus flags any revocation that was started but never finished. Watch the Render logs for those lines.
- **Secrets live only in Render**, never in the repo. `.env` is for local development and is gitignored.
- **Backups/DR:** Render can snapshot the disk; export the audit log periodically (or rely on `AUDIT_WEBHOOK_URL`) if you need long-term retention.

---

## Quick reference

| Setting | Value |
|---|---|
| Service type | Web Service (Node) |
| Build command | `npm ci` |
| Start command | `npm start` |
| Health check path | `/health` |
| Disk mount | `/var/data` (1 GB) |
| Events URL | `https://<app>.onrender.com/slack/events` |
| Interactivity URL | `https://<app>.onrender.com/slack/actions` |
