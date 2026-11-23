-- A9 Protocol W2: Persistent chain scan cursors, idempotent promo payout state machine,
-- and payout runner liveness heartbeats (purely additive over 0001..0009).

CREATE TABLE IF NOT EXISTS chain_scan_cursors (
  wallet_address TEXT PRIMARY KEY,
  last_lt TEXT NOT NULL,
  last_hash TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS promo_payouts (
  payout_id TEXT PRIMARY KEY, -- promo:<claimId>
  claim_id TEXT NOT NULL UNIQUE,
  wallet_address TEXT NOT NULL,
  wallet_key TEXT NOT NULL,
  amount_raw TEXT NOT NULL,
  query_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL, -- PENDING | BROADCASTING | RETRY | SENT | CONFIRMED | NEEDS_REVIEW
  attempts INTEGER NOT NULL DEFAULT 0,
  ambiguous INTEGER NOT NULL DEFAULT 0,
  tx_hash TEXT UNIQUE,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_promo_payouts_status
  ON promo_payouts(status, created_at);

CREATE TABLE IF NOT EXISTS runner_heartbeats (
  runner_id TEXT PRIMARY KEY,
  role TEXT NOT NULL, -- payout_daemon | presale | promo
  network TEXT NOT NULL,
  last_seen_at INTEGER NOT NULL,
  meta_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_runner_heartbeats_role
  ON runner_heartbeats(role, last_seen_at DESC);
