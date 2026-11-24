-- A9 Protocol v16 — Pre-Round Warm-Up Reservations, Intent Stats & Round Chests (migration 0011).
-- Zero contract changes: tracks per-round user intent before OpenRound, links to WARMUP_ROUND chests
-- in user_chests, and powers Telegram opening reminders without touching legacy warmup_registrations.

CREATE TABLE IF NOT EXISTS warmup_rounds (
  round_id INTEGER PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'OPEN', -- OPEN | PAUSED | CLOSED
  planned_open_at INTEGER,
  target_users INTEGER NOT NULL DEFAULT 500,
  chest_base_a9_raw TEXT NOT NULL DEFAULT '300000000000',
  chest_step_a9_raw TEXT NOT NULL DEFAULT '200000000000',
  chest_min_invites INTEGER NOT NULL DEFAULT 2,
  chest_max_invites INTEGER NOT NULL DEFAULT 5,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS warmup_reservations (
  round_id INTEGER NOT NULL,
  tg_user_id TEXT NOT NULL,
  wallet_address TEXT,
  wallet_key TEXT,
  wallet_active INTEGER NOT NULL DEFAULT 0,
  referrer_tg_id TEXT,
  intent_tier TEXT, -- 1000 | 5000 | 20000_plus | watching
  remind_enabled INTEGER NOT NULL DEFAULT 1,
  reminded_at INTEGER,
  raw_invites INTEGER NOT NULL DEFAULT 0,
  valid_invites INTEGER NOT NULL DEFAULT 0,
  counted_for_referrer INTEGER NOT NULL DEFAULT 0,
  valid_counted_for_referrer INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'ACTIVE', -- ACTIVE | CANCELLED
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (round_id, tg_user_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_warmup_res_round_wallet_active
  ON warmup_reservations(round_id, wallet_key)
  WHERE wallet_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_warmup_res_round_rank
  ON warmup_reservations(round_id, status, valid_invites DESC, raw_invites DESC, created_at ASC);

CREATE INDEX IF NOT EXISTS idx_warmup_res_referrer
  ON warmup_reservations(round_id, referrer_tg_id);

CREATE INDEX IF NOT EXISTS idx_warmup_res_remind
  ON warmup_reservations(round_id, status, remind_enabled, reminded_at);

CREATE UNIQUE INDEX IF NOT EXISTS idx_user_chests_warmup_round
  ON user_chests(owner_user_id, slot_index)
  WHERE source = 'WARMUP_ROUND';
