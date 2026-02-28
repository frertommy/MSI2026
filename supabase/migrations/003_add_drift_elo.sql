-- Add drift_elo column to team_prices for odds drift signal transparency
ALTER TABLE team_prices ADD COLUMN IF NOT EXISTS drift_elo float DEFAULT 0;
