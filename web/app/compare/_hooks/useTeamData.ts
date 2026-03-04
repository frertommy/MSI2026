'use client';

import { useState, useEffect, useCallback, type Dispatch, type SetStateAction } from 'react';
import { fetchTeamData } from '../_services/compare.service';
import { enrichTeamData, type EnrichmentResult } from '../_utils/enrichment';
import { computeHeaderStats, computeTradingStats, computeHistogram } from '../_utils/stats';
import type { HeaderStats, TradingStats, HistogramBucket, ProbRow } from '../_types';
import { TIME_RANGES } from '../_types';

export interface TeamDataState {
  selectedTeam: string;
  setSelectedTeam: (team: string) => void;
  timeRange: number;
  setTimeRange: Dispatch<SetStateAction<number>>;
  loading: boolean;
  enrichment: EnrichmentResult | null;
  headerStats: HeaderStats | null;
  tradingStats: TradingStats | null;
  histogram: HistogramBucket[];
  probByFixture: Map<number, ProbRow>;
}

const EMPTY_ENRICHMENT: EnrichmentResult = {
  enrichedMatches: [],
  finishedMatches: [],
  upcomingMatches: [],
  chartData: [],
  matchDots: [],
  monthTicks: [],
  filteredPrices: [],
  priceByDate: new Map(),
  probByFixture: new Map(),
};

export function useTeamData(initialTeam: string): TeamDataState {
  const [selectedTeam, setSelectedTeam] = useState(initialTeam);
  const [timeRange, setTimeRange] = useState<number>(TIME_RANGES[TIME_RANGES.length - 1].days);
  const [loading, setLoading] = useState(false);

  const [enrichment, setEnrichment] = useState<EnrichmentResult | null>(null);
  const [headerStats, setHeaderStats] = useState<HeaderStats | null>(null);
  const [tradingStats, setTradingStats] = useState<TradingStats | null>(null);
  const [histogram, setHistogram] = useState<HistogramBucket[]>([]);
  const [probByFixture, setProbByFixture] = useState<Map<number, ProbRow>>(new Map());

  const loadTeam = useCallback(async (team: string, range: number) => {
    if (!team) { return; }
    setLoading(true);

    try {
      const data = await fetchTeamData(team);
      const result = enrichTeamData(team, data.prices, data.matches, data.xgData, data.probs, range);

      setEnrichment(result);
      setHeaderStats(computeHeaderStats(data.prices, result.filteredPrices, result.enrichedMatches));
      setTradingStats(computeTradingStats(result.filteredPrices, result.finishedMatches, result.probByFixture));
      setHistogram(computeHistogram(result.filteredPrices));
      setProbByFixture(result.probByFixture);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadTeam(selectedTeam, timeRange).catch(() => null);
  }, [selectedTeam, timeRange, loadTeam]);

  const enrichmentOrEmpty = enrichment ?? EMPTY_ENRICHMENT;

  return {
    selectedTeam,
    setSelectedTeam,
    timeRange,
    setTimeRange,
    loading,
    enrichment: enrichmentOrEmpty,
    headerStats,
    tradingStats,
    histogram,
    probByFixture,
  };
}
