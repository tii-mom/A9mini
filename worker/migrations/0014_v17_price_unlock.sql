-- Migration 0014: A9 v17.0 涨价解锁（Price-Unlock）协议扩展
-- 1) rounds_cache 新增头矿 6H / 14 天逐秒解锁 / 自动止损与急提参数列
-- 2) 新增 stake_referral_credits（好友通关 8% 返佣，走现有 0.06 GRAM 推广热钱包）
-- 3) 新增 round_jackpot_draws（每轮等权空投抽奖公示）
-- 4) promo_budget_ledger 增加 stake_referral 与 round_airdrop 两个预算桶

ALTER TABLE rounds_cache ADD COLUMN early_stake_raw TEXT NOT NULL DEFAULT '0';
ALTER TABLE rounds_cache ADD COLUMN early_window_seconds INTEGER NOT NULL DEFAULT 21600;
ALTER TABLE rounds_cache ADD COLUMN vesting_seconds INTEGER NOT NULL DEFAULT 1209600;
ALTER TABLE rounds_cache ADD COLUMN unlock_model TEXT NOT NULL DEFAULT 'LINEAR_14D';
ALTER TABLE rounds_cache ADD COLUMN fail_early_burn_bps INTEGER NOT NULL DEFAULT 500;
ALTER TABLE rounds_cache ADD COLUMN fail_late_burn_bps INTEGER NOT NULL DEFAULT 1000;
ALTER TABLE rounds_cache ADD COLUMN early_exit_burn_bps INTEGER NOT NULL DEFAULT 1500;
ALTER TABLE rounds_cache ADD COLUMN instant_discount_bps INTEGER NOT NULL DEFAULT 3000;

CREATE TABLE IF NOT EXISTS stake_referral_credits (
  credit_id TEXT PRIMARY KEY,
  round_id INTEGER NOT NULL,
  referrer_wallet TEXT NOT NULL,
  referee_wallet TEXT NOT NULL,
  referee_reward_raw TEXT NOT NULL,
  commission_raw TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING', -- PENDING | CREDITED
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_stake_referral_credits_referrer
  ON stake_referral_credits(referrer_wallet, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_stake_referral_credits_round
  ON stake_referral_credits(round_id, status);

CREATE TABLE IF NOT EXISTS round_jackpot_draws (
  round_id INTEGER PRIMARY KEY,
  seed_hash TEXT NOT NULL,
  winner_wallet TEXT NOT NULL,
  prize_raw TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING', -- PENDING | CREDITED
  created_at INTEGER NOT NULL
);

INSERT OR IGNORE INTO promo_budget_ledger (bucket_key, cap_raw, spent_raw, updated_at) VALUES
  ('stake_referral', '200000000000000000', '0', 0),
  ('round_airdrop', '50000000000000000', '0', 0);
