/**
 * Standalone pricing engine runner.
 * Usage: cd scheduler && npx tsx src/scripts/run-pricing.ts
 */
import "dotenv/config";
import { log } from "../logger.js";
import { runPricingEngine } from "../services/pricing-engine.js";

async function main() {
  const t0 = Date.now();
  log.info("═══ Running pricing engine (standalone) ═══");

  const result = await runPricingEngine();

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  log.info(`Done in ${elapsed}s`);
  log.info(`  team_prices rows: ${result.teamPriceRows}`);
  log.info(`  match_prob rows:  ${result.matchProbRows}`);
}

main().catch((err) => {
  log.error("FATAL", err instanceof Error ? err.message : err);
  process.exit(1);
});
