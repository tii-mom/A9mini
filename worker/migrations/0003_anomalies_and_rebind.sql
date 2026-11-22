-- Acceptance round 1 (owner rules of 2026-11-22): additive only, no data dropped.
-- 1) Anomalous inbound transfers are recorded for operator review instead of auto-refunding
--    with a fee. 2) Wallet re-binding is delayed and cancellable by the current wallet.
ALTER TABLE presale_inbound_txs ADD COLUMN anomaly_status TEXT; -- OPEN | REFUND_QUEUED | CLOSED_NO_REFUND
ALTER TABLE presale_inbound_txs ADD COLUMN refund_to TEXT;
ALTER TABLE presale_inbound_txs ADD COLUMN fault_party TEXT; -- USER | SYSTEM | UNKNOWN (operator decision)
ALTER TABLE presale_inbound_txs ADD COLUMN fee_nano TEXT;
ALTER TABLE presale_inbound_txs ADD COLUMN resolved_by TEXT;
ALTER TABLE presale_inbound_txs ADD COLUMN resolved_at INTEGER;
ALTER TABLE presale_inbound_txs ADD COLUMN resolution_note TEXT;
CREATE INDEX IF NOT EXISTS idx_presale_inbound_anomaly ON presale_inbound_txs(decision, anomaly_status, created_at);

ALTER TABLE wallet_bindings ADD COLUMN pending_wallet_address TEXT;
ALTER TABLE wallet_bindings ADD COLUMN pending_wallet_key TEXT;
ALTER TABLE wallet_bindings ADD COLUMN pending_effective_at INTEGER;
