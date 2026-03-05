-- Oracle v1.4: KR window degradation flag
-- Marks KR snapshots that fell back to all pre-kickoff data
-- because fewer than 2 bookmakers had snapshots within 6h of kickoff.

ALTER TABLE oracle_kr_snapshots
  ADD COLUMN IF NOT EXISTS kr_degraded BOOLEAN DEFAULT false;
