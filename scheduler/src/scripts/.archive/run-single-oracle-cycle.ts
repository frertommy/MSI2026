/**
 * run-single-oracle-cycle.ts
 *
 * One-shot script to run a single Oracle V1 cycle for testing.
 * Forces ORACLE_V1_ENABLED=true regardless of env var.
 *
 * Usage:
 *   cd scheduler
 *   npx tsx src/scripts/run-single-oracle-cycle.ts
 */

import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

// Force-enable the cycle for this one-shot run
process.env.ORACLE_V1_ENABLED = "true";

// Now import the cycle (after env is set)
const { runOracleV1Cycle } = await import("../services/oracle-v1-cycle.js");

async function main() {
  console.log("\n══════════════════════════════════════════════════════════════");
  console.log("  SINGLE ORACLE V1 CYCLE");
  console.log("  " + new Date().toISOString());
  console.log("══════════════════════════════════════════════════════════════\n");

  const result = await runOracleV1Cycle();

  console.log("\n══════════════════════════════════════════════════════════════");
  console.log("  CYCLE RESULT");
  console.log("══════════════════════════════════════════════════════════════\n");
  console.log(JSON.stringify(result, null, 2));
  console.log();
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
