import "dotenv/config";
import { validateEnv } from "./config/index.js";
import { log } from "./core/logger.js";
import { startHealthServer } from "./core/health.js";
import { Scheduler } from "./scheduler.js";

async function main() {
  log.info("MSI 2026 Scheduler starting up...");

  // Validate environment
  try {
    validateEnv();
    log.info("Environment validated");
  } catch (err) {
    log.error("Environment validation failed", err instanceof Error ? err.message : err);
    process.exit(1);
  }

  // Start health server
  const healthServer = startHealthServer();

  // Start scheduler
  const scheduler = new Scheduler();

  // Graceful shutdown
  const shutdown = (signal: string) => {
    log.info(`Received ${signal} — shutting down gracefully...`);
    scheduler.stop();
    healthServer.close(() => {
      log.info("Health server closed");
      log.info("Goodbye!");
      process.exit(0);
    });

    // Force exit after 10s
    setTimeout(() => {
      log.error("Forced exit after 10s timeout");
      process.exit(1);
    }, 10000);
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  // Start the scheduler (runs first cycle immediately)
  try {
    await scheduler.start();
  } catch (err) {
    log.error("Scheduler startup failed", err instanceof Error ? err.message : err);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
