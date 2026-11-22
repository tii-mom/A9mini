-- Phase 1 / P0-C: 修正 presale_payouts 唯一约束（增量迁移，保留全部历史数据）。
-- 原表级约束 UNIQUE(order_id, kind) 会错误阻塞同一订单号关联的多笔异常退款。
-- 修正后：
--   1) A9 发放唯一性按 order_id 约束（每笔合法订单最多发放一次 A9）；
--   2) 退款唯一性按实际入账交易 inbound_tx_hash 约束（每笔入账最多产生一次有效退款）。

CREATE TABLE presale_payouts_v4 (
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

INSERT INTO presale_payouts_v4 (
  payout_id, order_id, inbound_tx_hash, kind, recipient, amount, query_id,
  status, attempts, ambiguous, tx_hash, last_error, created_at, updated_at
)
SELECT
  payout_id, order_id, inbound_tx_hash, kind, recipient, amount, query_id,
  status, attempts, ambiguous, tx_hash, last_error, created_at, updated_at
FROM presale_payouts;

DROP TABLE presale_payouts;
ALTER TABLE presale_payouts_v4 RENAME TO presale_payouts;

CREATE INDEX IF NOT EXISTS idx_presale_payouts_status ON presale_payouts(status, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_presale_payouts_a9_order
  ON presale_payouts(order_id) WHERE kind = 'A9' AND order_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_presale_payouts_refund_inbound
  ON presale_payouts(inbound_tx_hash) WHERE kind = 'REFUND' AND inbound_tx_hash IS NOT NULL;
