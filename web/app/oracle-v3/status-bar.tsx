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
}

interface V3Health {
  status: string;
  team_count: number;
  last_settlement: string | null;
  last_market_refresh: string | null;
  last_bt_solve: {
    solve_timestamp: string;
    league: string;
    converged: boolean;
  } | null;
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

function barColor(used: number, budget: number): string {
  const ratio = used / budget;
  if (ratio < 0.5) return "bg-accent-green";
  if (ratio < 0.75) return "bg-accent-amber";
  return "bg-accent-red";
}

function barWidth(used: number, budget: number): number {
  return Math.min(100, Math.round((used / budget) * 100));
}

function formatInterval(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}min`;
  return `${(seconds / 3600).toFixed(1)}h`;
}

function ProviderPill({ row }: { row: CreditRow }) {
  const used = row.credits_used_today;
  const budget = row.daily_budget;
  const pct = barWidth(used, budget);
  const label = row.provider === "odds_api" ? "ODDS" : "SCORES";

  return (
    <div className="flex items-center gap-2">
      <span className="text-[10px] font-bold tracking-wider text-muted uppercase w-[42px]">
        {label}
      </span>
      <div className="w-16 h-[5px] rounded-full bg-border overflow-hidden">
        <div
          className={`h-full rounded-full transition-all ${barColor(used, budget)}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className={`text-[10px] font-mono tabular-nums ${budgetColor(used, budget)}`}>
        {used.toLocaleString()}/{budget.toLocaleString()}
      </span>
      {row.poll_interval_seconds && (
        <span className="text-[10px] text-muted font-mono hidden sm:inline">
          {formatInterval(row.poll_interval_seconds)}
        </span>
      )}
    </div>
  );
}

function HealthPill({ label, value, stale }: { label: string; value: string; stale?: boolean }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-[10px] font-bold tracking-wider text-muted uppercase">{label}</span>
      <span className={`text-[10px] font-mono ${stale ? "text-accent-red" : "text-muted"}`}>
        {value}
      </span>
    </div>
  );
}

export function StatusBar() {
  const [credits, setCredits] = useState<CreditRow[]>([]);
  const [health, setHealth] = useState<V3Health | null>(null);
  const [schedulerAlive, setSchedulerAlive] = useState<boolean | null>(null);

  async function refresh() {
    try {
      const { data } = await supabase.from("api_credits").select("*");
      if (data && data.length > 0) {
        setCredits(data as CreditRow[]);
        const lastPoll = (data as CreditRow[]).find(r => r.last_poll_at)?.last_poll_at;
        if (lastPoll) {
          const ageMins = (Date.now() - new Date(lastPoll).getTime()) / 60000;
          setSchedulerAlive(ageMins < 5);
        }
      }
    } catch { /* silent */ }

    try {
      const res = await fetch("/api/v3/health");
      if (res.ok) setHealth(await res.json());
    } catch { /* silent */ }
  }

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 60_000);
    return () => clearInterval(interval);
  }, []);

  const oddsApi = credits.find(r => r.provider === "odds_api");
  const apiFootball = credits.find(r => r.provider === "api_football");

  const lastPollAt = oddsApi?.last_poll_at ?? apiFootball?.last_poll_at;
  const isStaleSettlement = health?.last_settlement
    ? (Date.now() - new Date(health.last_settlement).getTime()) > 24 * 60 * 60 * 1000
    : false;

  return (
    <div className="border-b border-border px-6 py-1.5 bg-[#0d0d0d]">
      <div className="mx-auto max-w-7xl flex items-center gap-4 flex-wrap">
        {/* Scheduler status */}
        <div className="flex items-center gap-1.5 shrink-0">
          <div className={`h-1.5 w-1.5 rounded-full ${
            schedulerAlive === null ? "bg-muted" :
            schedulerAlive ? "bg-accent-green animate-pulse" : "bg-accent-red"
          }`} />
          <span className="text-[10px] text-muted font-mono uppercase tracking-wider">
            {schedulerAlive === null ? "..." : schedulerAlive ? "Live" : "Stale"}
          </span>
          {lastPollAt && (
            <span className="text-[10px] text-muted/60 font-mono hidden sm:inline">
              {formatAge(lastPollAt)}
            </span>
          )}
        </div>

        <div className="w-px h-3 bg-border shrink-0" />

        {/* API credit pills */}
        {oddsApi && <ProviderPill row={oddsApi} />}
        {apiFootball && <ProviderPill row={apiFootball} />}

        {/* V3 health metrics */}
        {health && (
          <>
            <div className="w-px h-3 bg-border shrink-0 hidden md:block" />
            <div className="hidden md:flex items-center gap-4">
              {health.last_settlement && (
                <HealthPill
                  label="Settlement"
                  value={formatAge(health.last_settlement)}
                  stale={isStaleSettlement}
                />
              )}
              {health.last_bt_solve && (
                <HealthPill
                  label="BT"
                  value={`${formatAge(health.last_bt_solve.solve_timestamp)}${health.last_bt_solve.converged ? "" : " !FAIL"}`}
                  stale={!health.last_bt_solve.converged}
                />
              )}
              {health.last_market_refresh && (
                <HealthPill
                  label="Refresh"
                  value={formatAge(health.last_market_refresh)}
                />
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
