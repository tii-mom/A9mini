-- Migration 0017: A9 v17 Actuarial Hardening — Order-Level Presale Reservations,
-- 48H Pending Reward Voucher Ledger & Legacy Reconciliation Audit Table.
-- Keeps existing 550,000,000 A9 promo cap (6 buckets) and 200,000,000 A9 presale base cap unchanged.

CREATE TABLE IF NOT EXISTS presale_order_reservations (
  order_id TEXT PRIMARY KEY,
  sku_id TEXT,
  base_a9_raw TEXT NOT NULL,
  reserved_bonus_raw TEXT NOT NULL DEFAULT '0',
  settled_bonus_raw TEXT NOT NULL DEFAULT '0',
  released_bonus_raw TEXT NOT NULL DEFAULT '0',
  reserved_referral_raw TEXT NOT NULL DEFAULT '0',
  referral_bps INTEGER NOT NULL DEFAULT 6,
  max_boost_bps INTEGER NOT NULL DEFAULT 0,
  bonus_status TEXT NOT NULL DEFAULT 'RESERVED',     -- RESERVED | SETTLED | RELEASED
  referral_status TEXT NOT NULL DEFAULT 'NONE',      -- NONE | RESERVED | CREDITED | RELEASED
  status TEXT NOT NULL DEFAULT 'ACTIVE',             -- ACTIVE | COMPLETED | RELEASED | NEEDS_REVIEW
  legacy_backfilled INTEGER NOT NULL DEFAULT 0,
  snapshot_network TEXT,
  snapshot_jetton_master TEXT,
  snapshot_presale_wallet TEXT,
  snapshot_promo_wallet TEXT,
  snapshot_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_presale_res_status
  ON presale_order_reservations(status, updated_at);

CREATE INDEX IF NOT EXISTS idx_presale_res_referral_status
  ON presale_order_reservations(referral_status, updated_at);

CREATE TABLE IF NOT EXISTS pending_reward_vouchers (
  voucher_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  source_bucket TEXT NOT NULL,                       -- free_chest_captain | warmup | prediction
  source_kind TEXT NOT NULL,                         -- FREE_CHEST | CAPTAIN_FOUNDING | WARMUP_CHEST | PREDICTION_WIN | PREDICTION_FIRST_LOSS
  source_ref TEXT NOT NULL,
  amount_raw TEXT NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING',            -- PENDING | ACTIVATED | EXPIRED_RELEASED
  activation_id TEXT,
  legacy_backfilled INTEGER NOT NULL DEFAULT 0,
  resolved_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_pending_vouchers_user_status
  ON pending_reward_vouchers(user_id, status, expires_at_ms);

CREATE INDEX IF NOT EXISTS idx_pending_vouchers_expire
  ON pending_reward_vouchers(status, expires_at_ms);

CREATE TABLE IF NOT EXISTS actuarial_reconciliation_items (
  item_id TEXT PRIMARY KEY,
  category TEXT NOT NULL,                            -- LEGACY_PENDING_VAULT_UNATTRIBUTABLE | LEGACY_PRESALE_UNRESERVED
  entity_key TEXT NOT NULL,
  recorded_raw TEXT NOT NULL,
  evidenced_raw TEXT NOT NULL DEFAULT '0',
  unexplained_raw TEXT NOT NULL DEFAULT '0',
  detail_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'OPEN',               -- OPEN | RESOLVED
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_actuarial_recon_cat_status
  ON actuarial_reconciliation_items(category, status, created_at);
