-- Add raw (unsmoothed) dollar price column for EMA fast-response layer
ALTER TABLE team_prices ADD COLUMN IF NOT EXISTS raw_dollar_price float;
