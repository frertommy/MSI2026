"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";

interface CreditRow {
  provider: string;
  credits_remaining: number | null;
  credits_used_today: number;
  daily_budget: number;
  last_poll_at: string | null;
  poll_interval_seconds: number | null;
  next_poll_at: string | null;
}

function formatInterval(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}min`;
  return `${(seconds / 3600).toFixed(1)}h`;
}

function formatAge(isoDate: string): string {
  const diff = Date.now() - new Date(isoDate).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function budgetColor(used: number, budget: number): string {
  const ratio = used / budget;
  if (ratio < 0.5) return "text-accent-green";
  if (ratio < 0.75) return "text-accent-amber";
  return "text-accent-red";
}

function barWidth(used: number, budget: number): number {
  return Math.min(100, Math.round((used / budget) * 100));
}

function barColor(used: number, budget: number): string {
  const ratio = used / budget;
  if (ratio < 0.5) return "bg-accent-green";
  if (ratio < 0.75) return "bg-accent-amber";
  return "bg-accent-red";
}

function estimateDailySpend(intervalSec: number | null): string {
  if (!intervalSec || intervalSec <= 0) return "—";
  // 5 leagues per poll cycle, each costs 1 credit
  const pollsPerDay = (24 * 3600) / intervalSec;
  const creditsPerDay = Math.round(pollsPerDay * 5);
  return `~${creditsPerDay}/day`;
}

function intervalLabel(seconds: number | null): string {
  if (!seconds) return "—";
  const base = `every ${formatInterval(seconds)}`;
  if (seconds <= 120) return `${base} — match imminent`;
  if (seconds <= 300) return `${base} — match soon`;
  if (seconds >= 7200) return `${base} — no matches`;
  return base;
}

function ProviderPill({ row }: { row: CreditRow }) {
  const used = row.credits_used_today;
  const budget = row.daily_budget;
  const pct = barWidth(used, budget);
  const label = row.provider === "odds_api" ? "ODDS API" : "API-FOOTBALL";

  return (
    <div className="flex items-center gap-3 min-w-0">
      {/* Provider label */}
      <span className="text-[10px] font-bold tracking-wider text-muted uppercase shrink-0 w-[80px]">
        {label}
      </span>

      {/* Usage bar */}
      <div className="flex items-center gap-2 min-w-0 flex-1">
        <div className="w-20 h-[6px] rounded-full bg-border overflow-hidden shrink-0">
          <div
            className={`h-full rounded-full transition-all ${barColor(used, budget)}`}
            style={{ width: `${pct}%` }}
          />
        </div>
        <span className={`text-[11px] font-mono tabular-nums shrink-0 ${budgetColor(used, budget)}`}>
          {used}/{budget}
        </span>
      </div>

      {/* Remaining */}
      {row.credits_remaining !== null && (
        <span className="text-[10px] text-muted font-mono shrink-0">
          {row.credits_remaining.toLocaleString()} rem
        </span>
      )}

      {/* Poll interval */}
      <span className="text-[10px] text-muted font-mono shrink-0 hidden sm:inline">
        {intervalLabel(row.poll_interval_seconds)}
      </span>

      {/* Estimated daily spend */}
      <span className="text-[10px] text-muted font-mono shrink-0 hidden md:inline">
        {estimateDailySpend(row.poll_interval_seconds)}
      </span>

      {/* Last updated */}
      {row.last_poll_at && (
        <span className="text-[10px] text-muted font-mono shrink-0 hidden lg:inline">
          {formatAge(row.last_poll_at)}
        </span>
      )}
    </div>
  );
}

export function CreditBar() {
  const [rows, setRows] = useState<CreditRow[]>([]);
  const [error, setError] = useState(false);

  async function fetchCredits() {
    try {
      const { data, error: fetchErr } = await supabase
        .from("api_credits")
        .select("*");

      if (fetchErr) {
        // Table doesn't exist yet or other error
        setError(true);
        return;
      }

      if (data && data.length > 0) {
        setRows(data as CreditRow[]);
        setError(false);
      }
    } catch {
      setError(true);
    }
  }

  useEffect(() => {
    fetchCredits();
    const interval = setInterval(fetchCredits, 60_000); // refresh every 60s
    return () => clearInterval(interval);
  }, []);

  // Don't render anything if table doesn't exist or no data
  if (error || rows.length === 0) {
    return (
      <div className="border-b border-border px-6 py-2">
        <div className="mx-auto max-w-7xl flex items-center gap-2">
          <div className="h-1.5 w-1.5 rounded-full bg-muted" />
          <span className="text-[10px] text-muted font-mono uppercase tracking-wider">
            Scheduler not connected
          </span>
        </div>
      </div>
    );
  }

  const oddsApi = rows.find((r) => r.provider === "odds_api");
  const apiFootball = rows.find((r) => r.provider === "api_football");

  return (
    <div className="border-b border-border px-6 py-1.5 bg-[#0d0d0d]">
      <div className="mx-auto max-w-7xl flex items-center gap-6 flex-wrap">
        {/* Live indicator */}
        <div className="flex items-center gap-1.5 shrink-0">
          <div className="h-1.5 w-1.5 rounded-full bg-accent-green animate-pulse" />
          <span className="text-[10px] text-muted font-mono uppercase tracking-wider">
            Live
          </span>
        </div>

        {/* Odds API */}
        {oddsApi && <ProviderPill row={oddsApi} />}

        {/* Divider */}
        {oddsApi && apiFootball && (
          <div className="w-px h-3 bg-border shrink-0 hidden sm:block" />
        )}

        {/* API-Football */}
        {apiFootball && <ProviderPill row={apiFootball} />}
      </div>
    </div>
  );
}
