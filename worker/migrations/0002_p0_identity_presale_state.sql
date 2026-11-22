-- Phase 1 / P0: additive migration. No table or column is dropped; legacy statuses
-- (PENDING_TON, PAID_A9, REFUNDED_*) stay readable and are normalised in code.

ALTER TABLE presale_orders ADD COLUMN wallet_key TEXT;
ALTER TABLE presale_orders ADD COLUMN tg_user_id TEXT;
ALTER TABLE presale_orders ADD COLUMN refund_reason TEXT;
ALTER TABLE presale_orders ADD COLUMN last_error TEXT;
ALTER TABLE presale_orders ADD COLUMN expires_at INTEGER NOT NULL DEFAULT 0;
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
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS presale_inbound_txs (
  tx_hash TEXT PRIMARY KEY,
  order_id TEXT,
  sender TEXT,
  value_nano TEXT NOT NULL,
  memo TEXT,
  decision TEXT NOT NULL, -- CONFIRM | REFUND | IGNORE_DUST | NEEDS_REVIEW
  reason TEXT,
  created_at INTEGER NOT NULL
);

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
  updated_at INTEGER NOT NULL,
  UNIQUE (order_id, kind)
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
