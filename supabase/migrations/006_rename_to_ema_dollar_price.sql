-- Rename raw_dollar_price → ema_dollar_price (stores EMA-smoothed price)
ALTER TABLE team_prices RENAME COLUMN raw_dollar_price TO ema_dollar_price;
