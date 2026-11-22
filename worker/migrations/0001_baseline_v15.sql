-- Baseline v15 schema as shipped at 9f138fb (kept verbatim for migration history).
-- A9 Protocol v15 — Complete Minimalist D1 / SQLite Schema
-- Covers: v15 round cache, 0-contract promo hot wallet, 0-contract presale hot wallet, warmup & team social.

CREATE TABLE IF NOT EXISTS rounds_cache (
  round_id INTEGER PRIMARY KEY,
  status TEXT NOT NULL,
  target_price_usd_e8 TEXT NOT NULL,
  twap_24h_usd_e8 TEXT NOT NULL,
  stake_open_at INTEGER NOT NULL,
  stake_close_at INTEGER NOT NULL,
  settled_at INTEGER NOT NULL DEFAULT 0,
  total_stake_raw TEXT NOT NULL DEFAULT '0',
  total_weight_raw TEXT NOT NULL DEFAULT '0',
  reward_budget_raw TEXT NOT NULL DEFAULT '0',
  qualified_candles INTEGER NOT NULL DEFAULT 0,
  candle_hash TEXT NOT NULL DEFAULT '0x0',
  immediate_bps INTEGER NOT NULL DEFAULT 0,
  locked_slices INTEGER NOT NULL DEFAULT 0,
  unlocked_slices INTEGER NOT NULL DEFAULT 0,
  burned_slices INTEGER NOT NULL DEFAULT 0,
  locked_total_raw TEXT NOT NULL DEFAULT '0',
  stake_count INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS round_candles (
  round_id INTEGER NOT NULL,
  candle_index INTEGER NOT NULL,
  period_start INTEGER NOT NULL,
  period_end INTEGER NOT NULL,
  twap_price_usd_e8 TEXT NOT NULL,
  qualified INTEGER NOT NULL,
  PRIMARY KEY (round_id, candle_index)
);

CREATE TABLE IF NOT EXISTS promo_balances (
  wallet_address TEXT PRIMARY KEY,
  claimable_raw TEXT NOT NULL DEFAULT '0',
  total_claimed_raw TEXT NOT NULL DEFAULT '0',
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS promo_claims (
  claim_id TEXT PRIMARY KEY,
  wallet_address TEXT NOT NULL,
  amount_raw TEXT NOT NULL,
  fee_required_nano TEXT NOT NULL,
  memo TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL, -- PENDING_FEE | FEE_CONFIRMED | PAYOUT_SENT | COMPLETED | EXPIRED | FAILED
  fee_tx_hash TEXT UNIQUE,
  payout_tx_hash TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS presale_orders (
  order_id TEXT PRIMARY KEY,
  wallet_address TEXT NOT NULL,
  referrer_id TEXT,
  ton_nano TEXT NOT NULL,
  a9_amount_raw TEXT NOT NULL,
  memo TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL, -- PENDING_TON | PAID_A9 | REFUNDED_FREE | REFUNDED_MINUS_FEE | DUST_IGNORED | EXPIRED
  inbound_tx_hash TEXT UNIQUE,
  payout_tx_hash TEXT,
  refund_ton_nano TEXT NOT NULL DEFAULT '0',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS warmup_registrations (
  round_id INTEGER NOT NULL,
  wallet_address TEXT NOT NULL,
  referrer_wallet TEXT,
  valid_invites INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'ACTIVE', -- ACTIVE | CANCELLED
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (round_id, wallet_address)
);

CREATE TABLE IF NOT EXISTS team_groups (
  team_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  captain_wallet TEXT NOT NULL,
  tg_group_handle TEXT,
  tg_chat_id TEXT,
  bind_status TEXT NOT NULL DEFAULT 'unbound', -- unbound | verifying | bound | expired
  member_count INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS team_members (
  wallet_address TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  joined_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS referrals (
  subject_key TEXT PRIMARY KEY,
  referrer_id TEXT NOT NULL,
  bound_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS prediction_rounds (
  round_id INTEGER PRIMARY KEY,
  winning_side TEXT NOT NULL, -- PASS | BURN
  actual_qualified INTEGER NOT NULL,
  settled_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS prediction_bets (
  round_id INTEGER NOT NULL,
  user_id TEXT NOT NULL,
  side TEXT NOT NULL, -- PASS | BURN
  guess_slots INTEGER,
  referrer_id TEXT,
  status TEXT NOT NULL DEFAULT 'OPEN', -- OPEN | WON_PENDING_ACTIVATION | LOST
  reward_raw TEXT NOT NULL DEFAULT '0',
  created_at INTEGER NOT NULL,
  PRIMARY KEY (round_id, user_id)
);

CREATE TABLE IF NOT EXISTS prediction_rewards (
  user_id TEXT PRIMARY KEY,
  pending_activation_raw TEXT NOT NULL DEFAULT '0',
  activated_raw TEXT NOT NULL DEFAULT '0',
  pending_expires_at INTEGER, -- epoch ms (2 rounds / 48h TTL)
  total_settled INTEGER NOT NULL DEFAULT 0,
  total_won INTEGER NOT NULL DEFAULT 0,
  streak INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_promo_claims_wallet ON promo_claims(wallet_address, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_presale_orders_wallet ON presale_orders(wallet_address, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_warmup_rank ON warmup_registrations(round_id, valid_invites DESC);
CREATE INDEX IF NOT EXISTS idx_referrals_referrer ON referrals(referrer_id, bound_at DESC);
CREATE INDEX IF NOT EXISTS idx_prediction_round ON prediction_bets(round_id, side);
CREATE INDEX IF NOT EXISTS idx_prediction_referrer ON prediction_bets(round_id, referrer_id);
