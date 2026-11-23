// A9 Protocol v15 — Acton-backed broadcaster for PromoPayoutRunner & PresalePayoutRunner.
// Runs `acton script --net <network> ../ops/tolk/promo_payout_v15.tolk` asynchronously when OPS_EXECUTE=1.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const V15_ROOT = resolve(__dirname, '../../v15');

export function createActonPromoBroadcaster({
  network = process.env.A9_NETWORK || 'testnet',
  hotWalletName = process.env.A9_PROMO_HOT_WALLET_NAME || 'promoHotWallet',
  jettonMasterAddress = process.env.A9_JETTON_MASTER_ADDRESS,
  transferGasNano = process.env.A9_PROMO_TRANSFER_GAS_NANO || '50000000',
  spawnImpl = null,
} = {}) {
  if (!jettonMasterAddress) throw new Error('A9_JETTON_MASTER_ADDRESS is required for live promo broadcaster');
  if (network !== 'testnet' && network !== 'mainnet') throw new Error(`invalid network: ${network}`);

  return async function broadcastPromoPayout(payoutInstruction) {
    const queryId = payoutInstruction.queryId ? String(payoutInstruction.queryId) : String(Date.now());
    const env = {
      ...process.env,
      OPS_EXECUTE: 'true',
      A9_PROMO_HOT_WALLET_NAME: hotWalletName,
      A9_JETTON_MASTER_ADDRESS: jettonMasterAddress,
      A9_PAYOUT_RECIPIENT: payoutInstruction.recipient,
      A9_PAYOUT_AMOUNT_RAW: String(payoutInstruction.jettonAmountRaw),
      A9_PROMO_TRANSFER_GAS_NANO: String(payoutInstruction.attachedTonNano || transferGasNano),
      A9_QUERY_ID: queryId,
    };

    let stdout = '';
    if (typeof spawnImpl === 'function') {
      const res = spawnImpl('acton', ['script', '--net', network, '../ops/tolk/promo_payout_v15.tolk'], {
        cwd: V15_ROOT,
        env,
        encoding: 'utf8',
      });
      if (res.status !== 0) {
        throw new Error(`acton promo payout failed (exit=${res.status}): ${res.stderr || res.stdout || ''}`.trim());
      }
      stdout = String(res.stdout || '');
    } else {
      const res = await execFileAsync('acton', ['script', '--net', network, '../ops/tolk/promo_payout_v15.tolk'], {
        cwd: V15_ROOT,
        env,
        encoding: 'utf8',
        timeout: 60000,
      });
      stdout = String(res.stdout || '');
    }

    const match = stdout.match(/PROMO_PAYOUT_TX=(0x[0-9a-fA-F]+)/);
    if (!match) {
      throw new Error('acton promo payout completed without emitting PROMO_PAYOUT_TX hash');
    }
    return { txHash: match[1] };
  };
}
