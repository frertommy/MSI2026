import express from "express";
import type { Server } from "node:http";
import { PORT } from "../config/env.js";
import { log } from "./logger.js";
import type { HealthStatus } from "../types/index.js";

let healthData: HealthStatus = {
  status: "ok",
  uptime: 0,
  lastPoll: null,
  lastPollResult: null,
  credits: null,
  nextPollIn: null,
};

const startTime = Date.now();

export function updateHealth(partial: Partial<HealthStatus>): void {
  healthData = { ...healthData, ...partial };
}

export function startHealthServer(): Server {
  const app = express();

  app.get(["/", "/health"], (_req, res) => {
    res.set("Cache-Control", "no-cache");
    res.json({
      ...healthData,
      uptime: Math.round((Date.now() - startTime) / 1000),
    });
  });

  app.use((_req, res) => {
    res.status(404).json({ error: "Not Found" });
  });

  const server = app.listen(PORT, () => {
    log.info(`Health server listening on port ${PORT}`);
  });

  return server;
}
