CREATE TABLE IF NOT EXISTS prediction_activations (
  activation_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  wallet_key TEXT NOT NULL,
  wallet_address TEXT NOT NULL,
  amount_raw TEXT NOT NULL CHECK (amount_raw != '0'),
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_prediction_activations_user
  ON prediction_activations(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_prediction_activations_wallet
  ON prediction_activations(wallet_key, created_at DESC);
