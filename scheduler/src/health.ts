import http from "node:http";
import { PORT } from "./config.js";
import { log } from "./logger.js";
import type { HealthStatus } from "./types.js";

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

export function startHealthServer(): http.Server {
  const server = http.createServer((req, res) => {
    if (req.url === "/health" || req.url === "/") {
      const body = JSON.stringify(
        {
          ...healthData,
          uptime: Math.round((Date.now() - startTime) / 1000),
        },
        null,
        2
      );

      res.writeHead(200, {
        "Content-Type": "application/json",
        "Cache-Control": "no-cache",
      });
      res.end(body);
    } else {
      res.writeHead(404);
      res.end("Not Found");
    }
  });

  server.listen(PORT, () => {
    log.info(`Health server listening on port ${PORT}`);
  });

  return server;
}
