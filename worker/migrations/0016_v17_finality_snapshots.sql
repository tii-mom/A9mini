-- Migration 0016: A9 v17 返佣与空投链上终局证据快照（仅追加新迁移，不改写 0001..0015；本轮不执行远程迁移）
CREATE TABLE IF NOT EXISTS v17_round_finality_snapshots (
  round_id INTEGER PRIMARY KEY,
  network TEXT NOT NULL,
  round_controller TEXT NOT NULL,
  status_code INTEGER NOT NULL,
  settled_at INTEGER NOT NULL,
  settlement_tx_hash TEXT NOT NULL,
  candle_hash TEXT NOT NULL,
  total_stake_raw TEXT NOT NULL,
  reward_budget_raw TEXT NOT NULL,
  participant_count INTEGER NOT NULL,
  airdrop_seed_hash TEXT NOT NULL,
  evidence_hash TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_v17_finality_snapshots_net_rc
  ON v17_round_finality_snapshots(network, round_controller, round_id DESC);
