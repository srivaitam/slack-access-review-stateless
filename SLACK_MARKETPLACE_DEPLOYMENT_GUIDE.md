# Slack Access Review — Render Deployment & Slack Marketplace Guide

_A compiled record of the deployment/marketplace planning conversation._
_App: `slack-access-review-stateless` · Target host: Render · Date: 2026-07-04_

---

## App at a glance (from the codebase)

- **Stack:** Node.js + Express (`@slack/web-api`). Not FastAPI/Vite — different and simpler than AccessGuard.
- **State:** Stateless. No database, no Redis. Stores nothing (audit logs write to local disk only).
- **Slack mode:** HTTP events (not Socket Mode). Exposes public endpoints:
  - `POST /slack/events` — Slack events
  - `POST /slack/actions` — buttons, modals, view submissions
  - `GET /health` — health check
- **Auth today:** A single hardcoded bot token (`SLACK_BOT_TOKEN`) for **one** workspace.
- **Required env:** `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET` (optional: `NODE_ENV`, `LOG_LEVEL`).
- **Container:** Dockerfile present, runs as non-root, respects Render's injected `$PORT`, has a `/health` HEALTHCHECK.

---

## Q1 — Deploying this second app to Render (own workspace)

### Can a second app live in the same Render account?
Yes. Render runs many apps per account — each app is just another service. A basic paid plan supports this; you only pay for whatever instance the new service uses. Your existing **AccessGuard** deployment is untouched.

### How many services? → Just **1**
A single **Web Service (Docker)**.

- No Postgres, no Redis — the app is stateless.
- Optional: attach a small **Render Disk** only if you want `./audit-logs` to survive restarts. Render's filesystem is wiped on every deploy, so logs are otherwise lost. Not required to run.

### Deploy steps
1. Push this repo to GitHub (`push_to_github.bat` is included).
2. Render Dashboard → **New → Web Service** → connect the repo.
3. Runtime: **Docker** (Dockerfile is ready).
4. Set env vars: `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET` (+ optional `NODE_ENV=production`, `LOG_LEVEL=info`).
5. Deploy → you get a URL like `https://your-app.onrender.com`.

### Go live in your own workspace (Slack side)
In your Slack app config at api.slack.com/apps:

- **Event Subscriptions** → Request URL: `https://your-app.onrender.com/slack/events`
- **Interactivity & Shortcuts** → Request URL: `https://your-app.onrender.com/slack/actions`
- Add the **Bot Token Scopes** from your README, install to your workspace, copy the `xoxb-` token into Render.

**Result:** working in your own workspace today.

---

## Q2 — Listing on the full Slack Marketplace (public)

This is a multi-week project, not a config change. Key point: **your single-token app does not qualify as-is.**

### The gates Slack enforces
- App must already be installed and **active on 10+ workspaces** (active = used in the last 28 days).
- A **public OAuth 2.0 install flow** is mandatory.
- Review timeline: ~1 week preliminary + **up to ~7 weeks** functional review.
- Minimum-necessary scopes, each justified in the OAuth flow.
- HTTPS / TLS 1.2+ on every URL; distinctive icon (not resembling Slack/Slackbot); privacy policy + support URL; agree to Slack's App Developer Policy + Marketplace Agreement.

### 1. Code changes (the real work)
Convert from one hardcoded token to multi-workspace OAuth:

- Add `/slack/install` → HTTP 302 redirect to `slack.com/oauth/v2/authorize` with your scopes + a `state` value (CSRF protection).
- Add `/slack/oauth/callback` → exchange the `code` via `oauth.v2.access` → receive that workspace's bot token + `team_id`.
- **Store per-workspace tokens** keyed by `team_id` → this requires a database, so the app is no longer "stateless."
- On every event/action, look up the token by `team_id` from the payload instead of reading env.
- Handle `app_uninstalled` / `tokens.revoked` → delete that workspace's stored token.

### 2. Render setup changes
Now **2 services**: the Web Service **+ a Postgres database** (to hold tokens). Both fine on your paid account. Postgres alone is enough; add Redis only if you want it for OAuth `state`.

### 3. Slack app config
- Enable **Public Distribution** (Manage Distribution → complete the checklist, remove the hardcoded token).
- OAuth Redirect URL → `https://your-app.onrender.com/slack/oauth/callback`
- Event + Interactivity URLs on the public domain (as in Q1).

### 4. Submit
Reach 10+ active workspaces → app settings → **Submit to Marketplace** → complete the listing (name, short + long description, icon, scopes with reasons, privacy/support URLs) → preliminary then functional review.

**Bottom line:** Render is the easy part (add Postgres, one env change). The real work is (a) building the OAuth multi-tenant flow + token store, and (b) getting 10 real installs.

---

## Q3 — Chicken-and-egg: how do you get 10+ workspaces without a listing?

The problem dissolves once you separate two things Slack keeps distinct:

**Public distribution ≠ Marketplace listing.**

- **Public distribution** = flip on OAuth and get a shareable "Add to Slack" install link that *any* workspace can use. No listing required.
- **Marketplace listing** = a discovery catalog *on top* of that. It's how people find you, not how they install you.

### Correct order
Build OAuth → enable public distribution → get your install link → **hand it out directly** to reach 10+ active workspaces → *then* submit to Marketplace.

### Ways to get the first installs (no listing needed)
- Put the "Add to Slack" button on a landing page / your product site.
- Direct outreach — teams who'd want an access-review tool, partners, colleagues' companies, beta users.
- Relevant communities (Slack groups, LinkedIn, Product Hunt, founder/indie communities).
- Offer it free during beta.

### Caveat
"Active" means **used in the last 28 days** — they must actually run it, not just install. Don't fake it with throwaway workspaces; reviewers look for genuine usage.

**The Marketplace is the reward for traction, not the source of it.** Public distribution is the switch that lets you build that traction first.

---

## Summary / recommended sequence

1. **Now:** Deploy as 1 Web Service; go live in your own workspace (Q1).
2. **Then:** Build OAuth multi-workspace install flow + Postgres token store; add a `render.yaml` for both services.
3. **Enable public distribution;** share the "Add to Slack" link; grow to 10+ active workspaces.
4. **Submit to the Slack Marketplace;** pass preliminary + functional review.

---

## Sources
- [Slack Marketplace guidelines & requirements](https://docs.slack.dev/slack-marketplace/slack-marketplace-app-guidelines-and-requirements/)
- [Slack Marketplace readiness checklist](https://api.slack.com/reference/slack-apps/slack-marketplace-checklist)
- [Distributing your app in the Slack Marketplace](https://docs.slack.dev/slack-marketplace/distributing-your-app-in-the-slack-marketplace/)
- [Slack Marketplace review guide](https://docs.slack.dev/slack-marketplace/slack-marketplace-review-guide/)
