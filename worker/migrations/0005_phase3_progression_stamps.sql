-- Phase 3: 立体书手账集章成长系统（非金融成长数据，与链上 A9/GRAM 资产账本严格物理隔离）。
-- user_id 恒为服务端通过 Telegram initData 验签后的 telegramUserId。

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
  period_key TEXT NOT NULL, -- 日常印章为 UTC 'YYYY-MM-DD'，一次性成就为 'ONCE'
  exp_awarded INTEGER NOT NULL,
  claimed_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, task_key, period_key)
);

CREATE INDEX IF NOT EXISTS idx_user_task_claims_user_period
  ON user_task_claims(user_id, period_key);
