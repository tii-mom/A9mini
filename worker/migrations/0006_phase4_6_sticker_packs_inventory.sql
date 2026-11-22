-- Phase 4 & Phase 6: 三档贴纸礼盒、纸艺藏品背包与装扮账本（与链上 A9/GRAM 资产账本严格物理分表）。
-- 明确区分：
--   1) 链上真实代币/凭证（JettonWallet / StakeTicket / presale_orders）
--   2) 链上资产附带展示权益（A1-A9 持仓阶位）
--   3) 游戏数据库内的纸艺装扮道具（user_inventory_items / user_cosmetic_loadout / user_pack_deliveries）

CREATE TABLE IF NOT EXISTS user_inventory_items (
  user_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  category TEXT NOT NULL, -- 'frame' | 'badge' | 'title'
  rarity TEXT NOT NULL,   -- 'basic' | 'plus' | 'deluxe'
  source_sku TEXT NOT NULL, -- 'pack_basic' | 'pack_plus' | 'pack_deluxe'
  source_ref TEXT NOT NULL,
  acquired_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, item_id)
);

CREATE TABLE IF NOT EXISTS user_cosmetic_loadout (
  user_id TEXT PRIMARY KEY,
  equipped_frame TEXT,
  equipped_badge TEXT,
  equipped_title TEXT,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS user_pack_deliveries (
  delivery_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  sku_id TEXT NOT NULL,
  order_id TEXT UNIQUE,
  mode TEXT NOT NULL, -- 'SANDBOX' | 'ONCHAIN_ORDER'
  items_json TEXT NOT NULL,
  exp_awarded INTEGER NOT NULL DEFAULT 0,
  delivered_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_user_inventory_user
  ON user_inventory_items(user_id, category);
CREATE INDEX IF NOT EXISTS idx_user_pack_deliveries_user
  ON user_pack_deliveries(user_id, delivered_at DESC);
