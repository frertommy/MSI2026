import WebSocket from "ws";
import { getSupabase } from "../../core/supabase.js";
import { log } from "../../core/logger.js";
import type { LiveScoreEvent } from "../../types/index.js";

const WS_URL = "wss://sports-api.polymarket.com/ws";
const RECONNECT_DELAY_MS = 5_000;
const FOOTBALL_LEAGUES = new Set(["epl", "laliga", "bundesliga", "seriea", "ligue1"]);

export class SportsWsService {
  private ws: WebSocket | null = null;
  private running = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  start(): void {
    this.running = true;
    this.connect();
    log.info("SportsWsService started");
  }

  stop(): void {
    this.running = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    log.info("SportsWsService stopped");
  }

  private connect(): void {
    if (!this.running) { return; }

    log.info("SportsWsService connecting...");
    this.ws = new WebSocket(WS_URL);

    this.ws.on("open", () => {
      log.info("SportsWsService connected");
    });

    this.ws.on("message", (data) => {
      const text = data.toString();

      if (text === "ping") {
        this.ws?.send("pong");
        return;
      }

      try {
        const event = JSON.parse(text) as LiveScoreEvent;
        if (!FOOTBALL_LEAGUES.has(event.leagueAbbreviation?.toLowerCase())) { return; }
        this.upsertScore(event).catch((err) => {
          log.warn("SportsWsService upsert failed", err instanceof Error ? err.message : err);
        });
      } catch {
        // ignore non-JSON messages
      }
    });

    this.ws.on("close", (code) => {
      log.warn(`SportsWsService disconnected (code ${code}) — reconnecting in ${RECONNECT_DELAY_MS / 1000}s`);
      this.scheduleReconnect();
    });

    this.ws.on("error", (err) => {
      log.warn("SportsWsService error", err.message);
      this.ws?.close();
    });
  }

  private scheduleReconnect(): void {
    if (!this.running) { return; }
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, RECONNECT_DELAY_MS);
  }

  private async upsertScore(event: LiveScoreEvent): Promise<void> {
    const sb = getSupabase();
    const { error } = await sb
      .from("polymarket_live_scores")
      .upsert(
        {
          game_id: String(event.gameId),
          slug: event.slug,
          home_team: event.homeTeam,
          away_team: event.awayTeam,
          status: event.status,
          score: event.score,
          period: event.period,
          elapsed: event.elapsed,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "game_id" }
      );

    if (error) {
      log.warn("SportsWsService upsert error", error.message);
    } else {
      log.debug(`Live score updated: ${event.homeTeam} vs ${event.awayTeam} ${event.score} (${event.elapsed})`);
    }
  }
}
