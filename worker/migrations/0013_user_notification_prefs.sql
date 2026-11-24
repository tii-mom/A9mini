-- Wave 3: Persistent per-user Telegram DM notification preferences
CREATE TABLE IF NOT EXISTS user_notification_prefs (
  tg_user_id TEXT PRIMARY KEY,
  settlement_push INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_user_notification_prefs_settlement
  ON user_notification_prefs(settlement_push, updated_at DESC);
