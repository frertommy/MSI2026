import { getSupabase } from "../../core/supabase.js";
import { log } from "../../core/logger.js";
import type { ClobMidpointsResponse } from "../../types/index.js";

const CLOB_BASE = "https://clob.polymarket.com";
const POLL_INTERVAL_MS = 2_500;
const TOKEN_REFRESH_INTERVAL_MS = 10 * 60 * 1000;

interface TokenEntry {
  tokenId: string;
  eventSlug: string;
  outcome: string;
}

export class ClobPollerService {
  private running = false;
  private tokens: TokenEntry[] = [];
  private lastTokenRefresh = 0;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;

  start(): void {
    this.running = true;
    log.info("ClobPollerService started");
    this.schedulePoll();
  }

  stop(): void {
    this.running = false;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    log.info("ClobPollerService stopped");
  }

  private schedulePoll(): void {
    if (!this.running) { return; }
    this.pollTimer = setTimeout(async () => {
      await this.tick();
      this.schedulePoll();
    }, POLL_INTERVAL_MS);
  }

  private async tick(): Promise<void> {
    try {
      if (Date.now() - this.lastTokenRefresh >= TOKEN_REFRESH_INTERVAL_MS) {
        await this.refreshTokens();
      }

      if (this.tokens.length === 0) { return; }

      await this.pollMidpoints();
    } catch (err) {
      log.warn("ClobPollerService tick error", err instanceof Error ? err.message : err);
    }
  }

  private async refreshTokens(): Promise<void> {
    const sb = getSupabase();
    const { data, error } = await sb
      .from("polymarket_match_odds")
      .select("clob_token_id, polymarket_event_id, market_question, home_team, away_team")
      .eq("active", true)
      .not("clob_token_id", "is", null);

    if (error) {
      log.warn("ClobPollerService token refresh error", error.message);
      return;
    }

    this.tokens = (data ?? [])
      .filter((row) => row.clob_token_id)
      .map((row) => ({
        tokenId: row.clob_token_id as string,
        eventSlug: String(row.polymarket_event_id),
        outcome: resolveOutcome(row.market_question as string ?? ""),
      }));

    this.lastTokenRefresh = Date.now();
    log.info(`ClobPollerService refreshed ${this.tokens.length} tokens`);
  }

  private async pollMidpoints(): Promise<void> {
    const tokenIds = this.tokens.map((t) => t.tokenId).join(",");
    const url = `${CLOB_BASE}/midpoints?token_ids=${encodeURIComponent(tokenIds)}`;

    const resp = await fetch(url);
    if (!resp.ok) {
      log.warn(`ClobPollerService HTTP ${resp.status}`);
      return;
    }

    const data = (await resp.json()) as ClobMidpointsResponse;
    const snapshotAt = new Date().toISOString();
    const rows: Record<string, unknown>[] = [];

    for (const token of this.tokens) {
      const midPrice = data[token.tokenId];
      if (!midPrice) { continue; }

      rows.push({
        token_id: token.tokenId,
        event_slug: token.eventSlug,
        outcome: token.outcome,
        mid_price: parseFloat(midPrice),
        snapshot_at: snapshotAt,
      });
    }

    if (rows.length === 0) { return; }

    const sb = getSupabase();
    const { error } = await sb.from("polymarket_clob_prices").insert(rows);

    if (error) {
      log.warn("ClobPollerService insert error", error.message);
    } else {
      log.debug(`ClobPollerService saved ${rows.length} midpoints`);
    }
  }
}

function resolveOutcome(question: string): string {
  const q = question.toLowerCase();
  if (q.includes("draw")) { return "draw"; }
  if (q.includes("win") && (q.includes("home") || q.startsWith("will") && !q.includes("away"))) {
    return "home_win";
  }
  if (q.includes("away") || q.includes("win")) { return "away_win"; }
  return "other";
}
