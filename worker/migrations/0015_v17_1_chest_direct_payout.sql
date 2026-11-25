-- A9 Protocol v17.1 — Chest Mall merged direct payout with strict accounting isolation
-- order.a9_amount_raw stores ONLY guaranteed baseA9Raw (used for 200,000,000 A9 Phase 1 cap and 6% referral).
-- bonus_a9_raw stores the one-time idempotent random bonus rolled on first payout queueing (never re-rolled on retries).
-- Only payout.amount merges baseA9Raw + bonusA9Raw when dispatching on-chain A9 transfer.

ALTER TABLE presale_orders ADD COLUMN bonus_a9_raw TEXT NOT NULL DEFAULT '0';
ALTER TABLE presale_orders ADD COLUMN bonus_rolled INTEGER NOT NULL DEFAULT 0;
