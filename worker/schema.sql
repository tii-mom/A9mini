-- A9 Protocol v15 — Complete Minimalist D1 / SQLite Schema (fresh install).
-- Existing databases: apply worker/migrations/*.sql in order instead.
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
  status TEXT NOT NULL, -- PENDING_PAYMENT | PAYMENT_CONFIRMED | PAYOUT_PENDING | PAYOUT_SENT | COMPLETED | PAYOUT_RETRY | NEEDS_REVIEW | REFUND_PENDING | REFUND_SENT | REFUNDED | EXPIRED | CANCELLED (legacy: PENDING_TON | PAID_A9 | REFUNDED_FREE | REFUNDED_MINUS_FEE)
  inbound_tx_hash TEXT UNIQUE,
  payout_tx_hash TEXT,
  refund_ton_nano TEXT NOT NULL DEFAULT '0',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  wallet_key TEXT,
  tg_user_id TEXT,
  refund_reason TEXT,
  last_error TEXT,
  expires_at INTEGER NOT NULL DEFAULT 0,
  sku_id TEXT,
  open_mode TEXT NOT NULL DEFAULT 'INSTANT'
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
  tg_member_count INTEGER NOT NULL DEFAULT 0,
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

CREATE INDEX IF NOT EXISTS idx_presale_orders_wallet_key ON presale_orders(wallet_key, created_at DESC);

-- ---------------------------------------------------------------------------
-- P0 (gamification v1, phase 1): server-side identity + recoverable presale state machine.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS auth_ton_proof_payloads (
  payload TEXT PRIMARY KEY,
  tg_user_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS wallet_bindings (
  tg_user_id TEXT PRIMARY KEY,
  wallet_address TEXT NOT NULL,
  wallet_key TEXT NOT NULL UNIQUE, -- canonical raw "wc:hex"
  bound_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  pending_wallet_address TEXT,
  pending_wallet_key TEXT,
  pending_effective_at INTEGER
);

CREATE TABLE IF NOT EXISTS presale_inbound_txs (
  tx_hash TEXT PRIMARY KEY,
  order_id TEXT,
  sender TEXT,
  value_nano TEXT NOT NULL,
  memo TEXT,
  decision TEXT NOT NULL, -- CONFIRM | REFUND | IGNORE_DUST | OTHER_FLOW | ANOMALY | NEEDS_REVIEW
  reason TEXT,
  created_at INTEGER NOT NULL,
  anomaly_status TEXT, -- OPEN | REFUND_QUEUED | CLOSED_NO_REFUND
  refund_to TEXT,
  fault_party TEXT, -- USER | SYSTEM | UNKNOWN (operator decision)
  fee_nano TEXT,
  resolved_by TEXT,
  resolved_at INTEGER,
  resolution_note TEXT
);
CREATE INDEX IF NOT EXISTS idx_presale_inbound_anomaly ON presale_inbound_txs(decision, anomaly_status, created_at);

CREATE TABLE IF NOT EXISTS presale_payouts (
  payout_id TEXT PRIMARY KEY, -- a9:<orderId> | refund:<inboundTxHash>
  order_id TEXT,
  inbound_tx_hash TEXT,
  kind TEXT NOT NULL, -- A9 | REFUND
  recipient TEXT NOT NULL,
  amount TEXT NOT NULL, -- A9 raw or GRAM nano
  query_id TEXT NOT NULL,
  status TEXT NOT NULL, -- PENDING | BROADCASTING | RETRY | SENT | CONFIRMED | NEEDS_REVIEW
  attempts INTEGER NOT NULL DEFAULT 0,
  ambiguous INTEGER NOT NULL DEFAULT 0,
  tx_hash TEXT UNIQUE,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS presale_referral_credits (
  order_id TEXT PRIMARY KEY, -- one referral reward per completed order
  referrer TEXT NOT NULL,
  amount_raw TEXT NOT NULL,
  status TEXT NOT NULL, -- PENDING | CREDITING | CREDITED | NEEDS_REVIEW
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_presale_orders_status ON presale_orders(status, created_at);
CREATE INDEX IF NOT EXISTS idx_presale_payouts_status ON presale_payouts(status, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_presale_payouts_a9_order
  ON presale_payouts(order_id) WHERE kind = 'A9' AND order_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_presale_payouts_refund_inbound
  ON presale_payouts(inbound_tx_hash) WHERE kind = 'REFUND' AND inbound_tx_hash IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Phase 3: Handbook Stamp & Non-Financial Progression System
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS user_progression (
  user_id TEXT PRIMARY KEY,
  exp INTEGER NOT NULL DEFAULT 0,
  level INTEGER NOT NULL DEFAULT 1,
  checkin_streak INTEGER NOT NULL DEFAULT 0,
  last_checkin_day TEXT, -- UTC 'YYYY-MM-DD'
  total_stamps INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS user_task_claims (
  user_id TEXT NOT NULL,
  task_key TEXT NOT NULL,
  period_key TEXT NOT NULL, -- UTC 'YYYY-MM-DD' for daily stamps, 'ONCE' for achievements
  exp_awarded INTEGER NOT NULL,
  claimed_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, task_key, period_key)
);

CREATE INDEX IF NOT EXISTS idx_user_task_claims_user_period
  ON user_task_claims(user_id, period_key);

-- ---------------------------------------------------------------------------
-- Telegram Group Broadcast Deduplication (Cloudflare Worker stateless safety)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tg_broadcast_events (
  event_key TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  sent_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tg_broadcast_events_created
  ON tg_broadcast_events(created_at DESC);

-- ---------------------------------------------------------------------------
-- Chest Mall & Viral Social Assist System (migration 0008)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS user_chests (
  chest_id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL,
  owner_wallet_key TEXT,
  source TEXT NOT NULL,
  tier TEXT NOT NULL,
  slot_index INTEGER NOT NULL DEFAULT 1,
  order_id TEXT UNIQUE,
  base_a9_raw TEXT NOT NULL DEFAULT '0',
  boost_a9_raw TEXT NOT NULL DEFAULT '0',
  max_boost_a9_raw TEXT NOT NULL DEFAULT '0',
  required_assists INTEGER NOT NULL DEFAULT 2,
  current_assists INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'LOCKED',
  expires_at INTEGER,
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
  assist_day TEXT NOT NULL,
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
  status TEXT NOT NULL DEFAULT 'CREDITED_PENDING',
  created_at INTEGER NOT NULL
);
