-- A9 Protocol v16.1 — Actuarial & Anti-Abuse Hardening (migration 0012).
-- 1) Captain founding bonus deduplication by tg_chat_id, captain_user_id, and captain_wallet_key
--    (SQLite/D1 compatible: plain ALTER TABLE ADD COLUMN + standalone CREATE UNIQUE INDEX).
-- 2) Global off-chain promo budget ledger (300,000,000 A9 hard cap across 4 buckets, BigInt TEXT + CAS).

ALTER TABLE captain_founding_bonuses ADD COLUMN tg_chat_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_captain_bonus_tg_chat
  ON captain_founding_bonuses(tg_chat_id)
  WHERE tg_chat_id IS NOT NULL AND tg_chat_id != '';

CREATE UNIQUE INDEX IF NOT EXISTS idx_captain_bonus_user
  ON captain_founding_bonuses(captain_user_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_captain_bonus_wallet
  ON captain_founding_bonuses(captain_wallet_key);

CREATE TABLE IF NOT EXISTS promo_budget_ledger (
  bucket_key TEXT PRIMARY KEY,
  cap_raw TEXT NOT NULL,
  spent_raw TEXT NOT NULL DEFAULT '0',
  updated_at INTEGER NOT NULL DEFAULT 0
);

INSERT OR IGNORE INTO promo_budget_ledger (bucket_key, cap_raw, spent_raw, updated_at) VALUES
  ('presale_promo', '48000000000000000', '0', 0),
  ('free_chest_captain', '100000000000000000', '0', 0),
  ('prediction', '100000000000000000', '0', 0),
  ('warmup', '52000000000000000', '0', 0);
