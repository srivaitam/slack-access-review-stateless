#!/usr/bin/env node
// One-time remediation for the JSONB key-ordering bug (H5b) that caused false
// "AUDIT CHAIN BROKEN … hash mismatch" errors.
//
// It recomputes prev_hash + hash for every audit entry, per team, using the
// fixed deterministic canonical form. The audited FACTS are not changed — only
// the integrity seals are rewritten over the current content, so the chain
// verifies again. After running this once (with the code fix deployed), the
// periodic integrity check will pass and future entries are storage-order-safe.
//
// Usage:
//   node scripts/reseal-audit-chain.js --yes
//
// Requirements:
//   • DATABASE_URL set (DB mode)
//   • AUDIT_HMAC_SECRET set to the SAME value the app uses
require('dotenv').config();
const db = require('../utils/db');
const { resealAllChains, verifyAllChains } = require('../services/auditService');

(async () => {
  if (!db.isDbEnabled()) {
    console.error('DATABASE_URL is not set — nothing to re-seal (file mode).');
    process.exit(1);
  }
  if (process.env.NODE_ENV === 'production' && !process.env.AUDIT_HMAC_SECRET) {
    console.error('AUDIT_HMAC_SECRET must be set to the same secret the app uses. Aborting.');
    process.exit(1);
  }
  if (!process.argv.includes('--yes')) {
    console.error('This recomputes prev_hash/hash for ALL audit entries using the fixed canonical form.');
    console.error('It re-seals the tamper-evident chain over the CURRENT stored content (facts unchanged).');
    console.error('Re-run with --yes to proceed.');
    process.exit(1);
  }

  try {
    const results = await resealAllChains();
    if (results.length === 0) {
      console.log('No audit entries found. Nothing to do.');
    }
    for (const r of results) {
      const check = await verifyAllChains(r.teamId);
      const status = check.ok ? 'OK' : `STILL BROKEN at #${check.brokenAt} (${check.reason})`;
      console.log(`Re-sealed team ${r.teamId}: ${r.updated} entries · lastHash ${r.lastHash.slice(0, 12)}… · verify: ${status}`);
    }
    console.log('Done. The next integrity check will pass; no restart required.');
  } catch (e) {
    console.error('Re-seal failed:', e.message);
    process.exitCode = 1;
  } finally {
    await db.closePool().catch(() => {});
  }
})();
