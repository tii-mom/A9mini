-- Cache confirmed sender-side debit evidence by chain and JettonWallet.
CREATE TABLE IF NOT EXISTS hot_wallet_payout_debits (
  network TEXT NOT NULL,
  jetton_master TEXT NOT NULL,
  jetton_wallet TEXT NOT NULL,
  tx_hash TEXT NOT NULL,
  debit_lt TEXT NOT NULL,
  PRIMARY KEY (network, jetton_master, jetton_wallet, tx_hash)
);
