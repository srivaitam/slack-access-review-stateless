const Bottleneck = require('bottleneck');

const perMin = (name, def) => Number(process.env[name] || def);

// Reservoirs are tunable per workspace size (R8). Defaults track Slack tiers:
// Tier 2 ≈ 20/min, Tier 3 ≈ 50/min, Tier 4 ≈ 100/min.
const limiters = {
  tier2: new Bottleneck({ reservoir: perMin('SLACK_TIER2_PER_MIN', 20), reservoirRefreshAmount: perMin('SLACK_TIER2_PER_MIN', 20), reservoirRefreshInterval: 60000, maxConcurrent: 5 }),
  tier3: new Bottleneck({ reservoir: perMin('SLACK_TIER3_PER_MIN', 50), reservoirRefreshAmount: perMin('SLACK_TIER3_PER_MIN', 50), reservoirRefreshInterval: 60000, maxConcurrent: 10 }),
  tier4: new Bottleneck({ reservoir: perMin('SLACK_TIER4_PER_MIN', 100), reservoirRefreshAmount: perMin('SLACK_TIER4_PER_MIN', 100), reservoirRefreshInterval: 60000, maxConcurrent: 15 })
};

function withRateLimit(tier, fn) {
  return limiters[tier].wrap(fn);
}

module.exports = { withRateLimit, limiters };
