-- A9 Protocol v15 — Chest Mall (0.99 / 4.99 / 9.99 / 19.99 / 99.99 GRAM) & Viral Social Assist Chests.
-- Zero v15 contract changes. Preserves pure 1 GRAM = 2,002 A9 fixed principal quote; boost & free tier rewards
-- strictly originate from the independent promotional reward pool.

ALTER TABLE presale_orders ADD COLUMN sku_id TEXT;
ALTER TABLE presale_orders ADD COLUMN open_mode TEXT NOT NULL DEFAULT 'INSTANT';
ALTER TABLE team_groups ADD COLUMN tg_member_count INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS user_chests (
  chest_id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL,
  owner_wallet_key TEXT,
  source TEXT NOT NULL,           -- 'FREE_TIER' | 'SHOP_BOOST'
  tier TEXT NOT NULL,             -- 'bronze' | 'silver' | 'gold' | 'platinum' | 'diamond'
  slot_index INTEGER NOT NULL DEFAULT 1, -- 1..3 for serial bronze chests, 1 for others
  order_id TEXT UNIQUE,           -- linked presale_orders.order_id for SHOP_BOOST
  base_a9_raw TEXT NOT NULL DEFAULT '0',
  boost_a9_raw TEXT NOT NULL DEFAULT '0',
  max_boost_a9_raw TEXT NOT NULL DEFAULT '0',
  required_assists INTEGER NOT NULL DEFAULT 2,
  current_assists INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'LOCKED', -- 'LOCKED' | 'ACTIVE' | 'READY' | 'OPENED' | 'EXPIRED'
  expires_at INTEGER,             -- epoch sec (24h boost window for SHOP_BOOST; NULL for FREE_TIER)
  opened_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_user_chests_owner
  ON user_chests(owner_user_id, source, created_at ASC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_user_chests_free_slot
  ON user_chests(owner_user_id, tier, slot_index) WHERE source = 'FREE_TIER';

CREATE TABLE IF NOT EXISTS chest_assists (
  chest_id TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  helper_user_id TEXT NOT NULL,
  helper_wallet_key TEXT NOT NULL,
  assist_day TEXT NOT NULL,       -- UTC 'YYYY-MM-DD'
  boost_delta_raw TEXT NOT NULL DEFAULT '0',
  created_at INTEGER NOT NULL,
  PRIMARY KEY (chest_id, helper_wallet_key)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_chest_assists_chest_user
  ON chest_assists(chest_id, helper_user_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_chest_assists_owner_helper_wallet
  ON chest_assists(owner_user_id, helper_wallet_key);
CREATE INDEX IF NOT EXISTS idx_chest_assists_helper_day
  ON chest_assists(helper_wallet_key, assist_day);

CREATE TABLE IF NOT EXISTS captain_founding_bonuses (
  team_id TEXT PRIMARY KEY,
  captain_user_id TEXT NOT NULL,
  captain_wallet_key TEXT NOT NULL,
  tg_member_count INTEGER NOT NULL,
  amount_raw TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'CREDITED_PENDING', -- 'CREDITED_PENDING'
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS chest_open_credits (
  chest_id TEXT PRIMARY KEY,
  recipient_key TEXT NOT NULL,
  destination TEXT NOT NULL,      -- 'PROMO_BALANCE' | 'PENDING_VAULT'
  amount_raw TEXT NOT NULL,
  open_token TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);
