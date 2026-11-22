-- Phase 8: 彻底移除商品道具售卖 A9 相关的贴纸/装扮表，并新增极简 TG 群战报去重表。
-- 严格遵守：全站零商品道具概念，保留纯正 1 GRAM = 2,002 A9 内盘固定兑换。

DROP TABLE IF EXISTS user_inventory_items;
DROP TABLE IF EXISTS user_cosmetic_loadout;
DROP TABLE IF EXISTS user_pack_deliveries;

CREATE TABLE IF NOT EXISTS tg_broadcast_events (
  event_key TEXT PRIMARY KEY, -- 例如 open:3 / sprint:3 / settle:3 / whale:ord_abc123
  event_type TEXT NOT NULL,   -- 'ROUND_OPEN' | 'SPRINT_4H' | 'ROUND_SETTLE' | 'WHALE_EXCHANGE'
  sent_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tg_broadcast_events_created
  ON tg_broadcast_events(created_at DESC);
