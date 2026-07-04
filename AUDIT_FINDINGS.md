# Slack Access Review — Audit Findings Report

**Scope:** Full 8-area pass (Security, Performance, Architecture, Reliability, Compliance, UX/a11y, Testing/CI, DR).
**Tree audited:** `slack-access-review-stateless/` (Node.js + Express + `@slack/web-api`; stateless posture, file-based audit log).
**Method:** Full manual read of every source file (2,660 LOC) + `npm audit` + secrets grep + authZ/route grep, cross-checked. Criticals re-verified line-by-line against source.
**Headline:** 4 Critical · 8 High · 8 Medium · ~9 Low. The app has some good instincts (ack-first async handling, HMAC signature verification with `timingSafeEqual`, per-channel error capture on revoke, concurrency cap on fan-out). But it ships with **live credentials in `.env`**, **signature verification disabled by the committed config**, and **authorization enforced at only one of four privileged entry points** — so the two most damaging operations (revocation and full-workspace export) are effectively unauthenticated as configured.

**Severity scheme:** Critical = secret exposure, unauthenticated privileged action, or silent-truncation that makes the tool report false "clean." High = authZ/integrity gaps, vulnerable deps, scale/rate-limit meltdowns, DR/compliance holes. Medium = hardening & correctness. Low = cleanup, dead code, cosmetics.

---

## ✅ Remediation status — updated 2026-07-04

**All findings are fixed — Critical, High, Medium, and Low.** Verified by `npm audit` (0 vulnerabilities), unit tests (risk scoring + audit-chain tamper detection), and isolated logic runs (CSV guard, idempotency guard, configurable risk scoring). Dead code, scaffolding scripts, and config polish are all cleaned up.

| Tier | Status |
|---|---|
| Critical — C1, C2, C3, C4 | ✅ Fixed |
| High — H1–H8 | ✅ Fixed |
| Medium — M1–M8 | ✅ Fixed |
| Low (~9 items) | ✅ Fixed |

**Two required production config steps:** set `AUDIT_HMAC_SECRET` (required in production for the tamper-evident log) and optionally `AUDIT_WEBHOOK_URL` for a durable off-host audit sink; and **rotate** the Slack bot token + signing secret that were previously committed to `.env`.

---

## CRITICAL — ✅ all fixed (2026-07-04)

**C1 — Signature verification disabled by shipped config.** `index.js:215` (and dead copy `utils/slackVerification.js:4`) — `verifySignature` returns `true` whenever `NODE_ENV === 'development'`, and `.env:4` ships `NODE_ENV=development`. As delivered, **every** request to `/slack/events` and `/slack/actions` skips HMAC verification, so anyone who can reach the URL can forge Slack interactions — including `confirm_revocation` (see C3). **Fix:** remove the env-based bypass; verify signatures unconditionally, or gate the bypass behind an explicit `ALLOW_INSECURE_SLACK=1` that hard-fails to start when `NODE_ENV=production`. *(Verified.)*

**C2 — Live Slack credentials committed in `.env`.** `.env:1-2` — a real `SLACK_BOT_TOKEN` (`xoxb-…`) and `SLACK_SIGNING_SECRET` are checked into the working tree. The bot token grants workspace-wide `users:read.email`, `channels:read`, `conversations.kick`/`join`, and `chat:write`; the signing secret is the sole thing standing between the internet and forged requests. `.gitignore` lists `.env`, but the secret is already present in the delivered artifact and must be treated as compromised. **Fix:** revoke/rotate both **now** in the Slack app admin, load secrets from a secret manager (never a file), and purge `.env` from any history. *(Verified.)*

**C3 — Revocation and export bypass authorization.** The only owner/admin check in the codebase is on the *modal-open* action `view_user_detail` (`handlers/actionHandler.js:77`). The operations that actually matter are ungated:
- `handlers/viewSubmissionHandler.js:348` (`confirm_revocation`) calls `revokeUserAccess` — kicking users from channels — with **no** owner/admin re-check. It trusts `payload.user.id` and client-supplied `private_metadata`. Combined with C1, an unauthenticated forged submission can revoke arbitrary users.
- `handlers/actionHandler.js:27` (`export_csv`) and `:50` (`export_excel`) DM the **entire** workspace access map — every user's name, email, role, and full channel list — to whoever clicked, with no role check.

**Fix:** enforce `is_owner || is_admin` server-side inside `handleViewSubmission` (both `user_access_modal` and `confirm_revocation`) and inside both export branches, before any Slack call — never rely on a gate at a prior UI step. *(Verified.)*

**C4 — No pagination anywhere → the review silently under-reports access.** Every Slack list call takes the first page only:
- `slack/users.js:4` — `users.list({ limit: 1000 })`, no `cursor` loop.
- `slack/channels.js:4` — `conversations.list({ limit: 1000 })`, no `cursor` loop.
- `slack/channelMembers.js:5` — `conversations.members({ limit: 1000 })`, no `cursor` loop.

On any workspace past those thresholds (channel counts and large-channel memberships exceed 1,000 routinely), users/channels/members are silently dropped. A governance tool that omits access it can't see reports a **false negative** — the most dangerous failure mode for this product. **Fix:** wrap all three in a `response_metadata.next_cursor` pagination loop; add a `truncated`/page-count signal surfaced in the UI and exports. *(Verified.)*

---

## HIGH — ✅ all fixed (2026-07-04)

**H1 — Vulnerable dependencies (high severity).** `npm audit` reports `axios` (**high** — SSRF via NO_PROXY bypass + numerous prototype-pollution gadgets, 20+ advisories), `form-data` (**high** — CRLF injection), and `follow-redirects` (moderate — auth-header leak on cross-domain redirect), pulled transitively under `@slack/web-api`. **Fix:** `npm audit fix` (and bump `@slack/web-api` to a release that pins patched transitive versions); wire `npm audit` into CI (see H8).

**H2 — Full snapshot recomputed on every interaction.** `generateAccessSnapshot()` runs a `conversations.members` fan-out across **all** channels each time it's called, and it's called on every button: refresh (`actionHandler.js:19`), `view_user_detail` for a *single* user (`actionHandler.js:93`), and twice for exports (`exportService.js:8` and `:49`). Repeated clicks re-scan the whole workspace. **Fix:** compute the snapshot once, cache it briefly (in-memory TTL keyed by workspace), and serve detail/export from the cached object.

**H3 — Rate limiter is dead code; the fan-out is unthrottled to Slack tiers.** `slack/rateLimiter.js` (Bottleneck tier2/tier3 limiters) is never imported. The members fan-out is bounded only by `pLimit(10)` (`accessService.js:20`) and WebClient retries. `conversations.members` is a Tier-3 method (~50 req/min); a medium workspace will 429 mid-scan. **Fix:** actually route Slack calls through the tiered limiter (or delete it and rely on `@slack/web-api`'s built-in `retryConfig` + `maxRequestConcurrency`, tuned to tiers).

**H4 — Audit trail lives on ephemeral local disk.** `services/auditService.js:5,22` appends to `./audit-logs/audit-YYYY-MM.jsonl`, and `.gitignore` excludes it. On any container/PaaS redeploy (Render, Heroku, K8s) the filesystem is wiped — so the tool's **only** compliance artifact is destroyed on every deploy, with no backup. **Fix:** ship audit events to durable storage (managed DB, object store, or a SIEM/log sink); treat local files as a dev-only fallback.

**H5 — Audit log has no tamper-resistance.** `services/auditService.js` writes plain JSONL that the app role can rewrite or delete; there's no hash chain, HMAC, or append-only guarantee. README claims "Compliance Ready for SOX/ISO27001," which requires tamper-evidence. **Fix:** chain each entry (`row_hash = HMAC(secret, prev_hash + canonical(entry))`) with the secret outside the writer's reach, or write to WORM/append-only storage.

**H6 — Error-swallowing makes failed lookups look empty.** `services/accessService.js:36-38` — if `getChannelMembers` throws, the channel is recorded with `members: [], memberIds: [], riskScore: 0`, i.e. indistinguishable from a genuinely empty channel. A transient Slack error therefore **hides** real access. (Same false-negative class as C4.) **Fix:** distinguish transient failure from empty; mark the channel `errored: true` and surface it rather than reporting zero members.

**H7 — Revocation is fire-and-forget after the modal closes.** `handlers/viewSubmissionHandler.js:369` runs `revokeUserAccess` inside `setImmediate` *after* returning `{ response_action: 'clear' }`. On a "stateless"/ephemeral host a restart between ack and execution drops the revocation silently — nothing kicked, nothing audited — and there's no idempotency key, so a ret/re-submit re-kicks. **Fix:** enqueue revocations on a durable queue (or at least log an "initiated" audit record before the async work), and add an idempotency key per `(userId, channelId, requestId)`.

**H8 — No tests, CI, lint, or secret scanning.** `package.json` defines only `start`/`dev`; there's no test suite, no workflow, no linter, no secrets gate — for a tool that revokes access and handles PII. **Fix:** add a CI pipeline with `npm ci`, lint, `npm audit` (failing on high/critical), a secrets scanner (gitleaks/detect-secrets), and at minimum authZ unit tests around the revoke/export handlers.

---

## MEDIUM — ✅ all fixed (2026-07-04)

**M1 — CSV formula injection in exports.** `services/exportService.js:96` — `csvEscape` quotes commas/quotes/newlines but does **not** neutralize leading `=`, `+`, `-`, or `@`. Channel names, topics, and display names are attacker-influenceable, so a channel named `=HYPERLINK(...)` executes as a formula when the export is opened in Excel/Sheets. **Fix:** prefix any cell beginning with `= + - @` (or tab/CR) with a single quote, or wrap in `="..."`.

**M2 — Raw error text leaked to users.** `handlers/actionHandler.js:114` DMs `'❌ Something went wrong: ' + error.message` straight from the caught exception — internal detail disclosure. **Fix:** log the detail server-side; show the user a generic message + correlation id.

**M3 — Revocation silently changes bot membership.** `services/revocationService.js:108-111` — `ensureBotInChannel` calls `conversations.join` on public channels as a side effect of a kick, and "logs but continues" on unknown join errors. The bot quietly joins channels it wasn't in (and posts nothing about it), altering the very membership surface being audited. **Fix:** make auto-join explicit and audited, or require the bot to be pre-invited and fail closed with a clear message.

**M4 — No timeouts or circuit breaker on the Slack fan-out.** `slack/client.js` sets retries but no per-call timeout; during a Slack slowdown all `pLimit` slots × retries stay occupied and the home view hangs. **Fix:** set explicit request timeouts and add a short-circuit/cooldown when Slack error rates spike.

**M5 — Production safety hinges on a single unset env var.** The dev bypass (C1) means forgetting to set `NODE_ENV=production` silently disables all authentication. **Fix:** invert the default — require verification always; make insecure mode opt-in and refuse to boot insecurely outside local.

**M6 — Home dashboard exposes all users to any member.** `handlers/eventHandler.js` (`app_home_opened`) renders the top-20 users with names, emails, and risk scores to **any** member who opens the App Home — no owner/admin gate (unlike `view_user_detail`). **Fix:** gate the dashboard render behind the same role check, or show non-admins only their own access.

**M7 — Failed home load leaves the user stuck.** `handlers/eventHandler.js:19-21` catches snapshot errors and only `console.error`s; the App Home stays on the "Fetching…" loading view with no error state or retry. **Fix:** publish an error view with a Retry button when the snapshot fails.

**M8 — `.env` is corrupted with pasted docs.** `.env:6-38` contains QUICKSTART markdown (code fences, headings) pasted after the real variables — fragile, hand-managed secret config. **Fix:** keep `.env` variables-only (and, per C2, move real secrets to a manager); commit a `.env.example` with placeholders instead.

---

## LOW — ✅ all fixed (2026-07-04)

- **Large blocks of stacked dead code** — `index.js` (3 commented versions), `handlers/viewSubmissionHandler.js` (3), `services/notificationService.js` (3), `modals/userAccessModal.js` (3), `views/usersAccessView.js` (2), `services/revocationService.js` (2). Delete; rely on git history.
- **Scaffolding scripts committed** — `create-all-files.sh`, `setup-files.sh` don't belong in the app repo.
- **Excel export is SpreadsheetML mislabeled `.xls`** (`handlers/actionHandler.js:125`) — works but MIME/format drift; emit `.xml` or a real `.xlsx`.
- **`getPrimaryDomain` picks the single most-common email domain as "internal"** (`riskScoringService.js:30`) — multi-domain orgs get external users misclassified in risk scoring. Make the internal domain(s) configurable.
- **Risk weights are hardcoded magic numbers** (`riskScoringService.js:3`) — externalize to config so governance teams can tune them.
- **No explicit WebClient request timeout** — relies on library defaults; set one.
- **Every checkbox toggle round-trips to the server** (`actionHandler.js:105` returns immediately but still receives `channel_checkbox_*` interactions) — harmless noise, but each is unauthenticated in dev mode.
- **`audit-logs/` is gitignored yet is the compliance record** — even as a dev fallback, retention/rotation is undefined.
- **No `.dockerignore`/deploy manifest** — `.env` and `node_modules` risk being copied into images.

---

## What's solid (don't re-flag)

Ack-first async handling keeps Slack's 3-second window (events ack then process; view submissions respond synchronously with push/clear/errors). Signature check, *when enabled*, is correct: HMAC-SHA256 over `v0:{ts}:{body}` with a 5-minute replay window and `crypto.timingSafeEqual`. Revocation captures per-channel failures with friendly error mapping rather than aborting the batch. The members fan-out is concurrency-capped (`pLimit`). Revocation reasons are required (≥10 chars) and recorded. The `view_user_detail` gate itself is implemented correctly — the problem is that it's the *only* one.

---

## Suggested fix order

1. **Today (Critical):** C2 (rotate & remove committed secrets) → C1 (remove signature bypass) → C3 (add server-side authZ to revoke + export + submissions) → C4 (paginate all three list calls).
2. **Next (High):** H1 (`npm audit fix` + CI gate), H4/H5 (durable, tamper-evident audit trail), H7 (durable revocation + idempotency), H2/H3 (cache snapshot, real rate-limiting), H6 (error-not-empty), H8 (CI/tests/lint/secret-scan).
3. **Then:** Medium hardening (M1 CSV injection, M2 error leakage, M3 auto-join, M5/M6 authZ defaults) and Low cleanup (dead code, scaffolding, config).

*Generated 2026-07-03; remediation applied 2026-07-04 — all Critical, High, Medium, and Low findings fixed. Original file:line references are a point-in-time snapshot from the audit; current source has shifted as fixes landed (dead code removed, files renumbered).*
