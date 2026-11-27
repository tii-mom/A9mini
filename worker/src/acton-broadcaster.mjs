// A9 Protocol v15/v16 — Acton-backed broadcasters for PromoPayoutRunner & PresalePayoutRunner.
// Runs Acton Tolk scripts asynchronously with strict safety gates and NO synthetic hash fallback.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_PROTOCOL_ROOT = resolve(__dirname, '../../v17');

function withActonNetworkKeyEnv(network, baseEnv = process.env) {
  const fallback = String(baseEnv?.TONCENTER_API_KEY || '').trim();
  if (network === 'mainnet') {
    const k = String(baseEnv?.TONCENTER_MAINNET_API_KEY || fallback).trim();
    return { ...baseEnv, ...(k ? { TONCENTER_MAINNET_API_KEY: k } : {}) };
  }
  if (network === 'testnet') {
    const k = String(baseEnv?.TONCENTER_TESTNET_API_KEY || fallback).trim();
    return { ...baseEnv, ...(k ? { TONCENTER_TESTNET_API_KEY: k } : {}) };
  }
  return { ...baseEnv };
}

function normalizeFullTxHashHex(rawHex) {
  const clean = String(rawHex || '').replace(/^0x/i, '').toLowerCase();
  return `0x${clean.padStart(64, '0')}`;
}

export function isDeterministicPreSendFailure(detail) {
  return /insufficient hot wallet|insufficient.*inventory|insufficient.*balance|insufficient.*gas|not deployed yet|wallet address mismatch|ops_confirm|missing positive|missing a9_|exceeds single-cell|enoent/i.test(String(detail || ''));
}

async function runActonScript({ network, scriptRelPath, cwd, env, spawnImpl }) {
  if (typeof spawnImpl === 'function') {
    const res = spawnImpl('acton', ['script', '--net', network, scriptRelPath], {
      cwd,
      env,
      encoding: 'utf8',
    });
    if (res.status !== 0) {
      const detail = `${res.stderr || res.stdout || ''}`.trim();
      const err = new Error(`acton script failed (exit=${res.status}): ${detail}`.trim());
      if (isDeterministicPreSendFailure(detail)) {
        err.notSent = true;
        err.deterministic = true;
      }
      throw err;
    }
    return String(res.stdout || '');
  }
  try {
    const res = await execFileAsync('acton', ['script', '--net', network, scriptRelPath], {
      cwd,
      env,
      encoding: 'utf8',
      timeout: 180000,
    });
    return String(res.stdout || '');
  } catch (err) {
    const detail = String(err?.stderr || err?.stdout || err?.message || err).trim();
    const outErr = new Error(`acton script failed (${scriptRelPath}): ${detail}`);
    if (isDeterministicPreSendFailure(detail) || err?.code === 'ENOENT') {
      outErr.notSent = true;
      outErr.deterministic = true;
    }
    throw outErr;
  }
}

export function createActonPromoBroadcaster({
  network = process.env.A9_NETWORK || 'testnet',
  hotWalletName = process.env.A9_PROMO_HOT_WALLET_NAME || 'promoHotWallet',
  expectedHotWalletAddress = process.env.A9_PROMO_HOT_WALLET_ADDRESS || null,
  jettonMasterAddress = process.env.A9_JETTON_MASTER_ADDRESS,
  transferGasNano = process.env.A9_PROMO_TRANSFER_GAS_NANO || '50000000',
  projectRoot = DEFAULT_PROTOCOL_ROOT,
  scriptPath = '../ops/tolk/promo_payout_v15.tolk',
  baseEnv = process.env,
  spawnImpl = null,
} = {}) {
  if (!jettonMasterAddress) throw new Error('A9_JETTON_MASTER_ADDRESS is required for live promo broadcaster');
  if (network !== 'testnet' && network !== 'mainnet') throw new Error(`invalid network: ${network}`);

  return async function broadcastPromoPayout(payoutInstruction) {
    const queryId = payoutInstruction.queryId ? String(payoutInstruction.queryId) : String(Date.now());
    const env = {
      ...withActonNetworkKeyEnv(network, baseEnv),
      OPS_EXECUTE: 'true',
      A9_NETWORK: network,
      A9_PROMO_HOT_WALLET_NAME: hotWalletName,
      ...(expectedHotWalletAddress ? { A9_EXPECTED_HOT_WALLET_ADDRESS: expectedHotWalletAddress } : {}),
      A9_JETTON_MASTER_ADDRESS: jettonMasterAddress,
      A9_PAYOUT_RECIPIENT: payoutInstruction.recipient,
      A9_PAYOUT_AMOUNT_RAW: String(payoutInstruction.jettonAmountRaw),
      A9_PROMO_TRANSFER_GAS_NANO: String(payoutInstruction.attachedTonNano || transferGasNano),
      A9_QUERY_ID: queryId,
    };

    const stdout = await runActonScript({ network, scriptRelPath: scriptPath, cwd: projectRoot, env, spawnImpl });
    const match = stdout.match(/PROMO_PAYOUT_TX=(0x[0-9a-fA-F]+)/);
    if (!match) {
      throw new Error('acton promo payout completed without emitting PROMO_PAYOUT_TX hash');
    }
    return { txHash: normalizeFullTxHashHex(match[1]) };
  };
}

/**
 * GRAM native refund broadcaster backed by ops/tolk/gram_refund_v15.tolk.
 * Strictly requires an explicit presale hot wallet name distinct from promoHotWallet.
 */
export function createActonGramRefundBroadcaster({
  network = process.env.A9_NETWORK || 'testnet',
  hotWalletName = process.env.A9_PRESALE_HOT_WALLET_NAME || '',
  expectedHotWalletAddress = process.env.A9_PRESALE_HOT_WALLET_ADDRESS || null,
  projectRoot = DEFAULT_PROTOCOL_ROOT,
  scriptPath = '../ops/tolk/gram_refund_v15.tolk',
  baseEnv = process.env,
  spawnImpl = null,
} = {}) {
  if (!hotWalletName) throw new Error('A9_PRESALE_HOT_WALLET_NAME is required for live GRAM refund broadcaster');
  if (network !== 'testnet' && network !== 'mainnet') throw new Error(`invalid network: ${network}`);

  return async function broadcastGramRefund(instruction) {
    const tonNano = BigInt(instruction?.tonNano || 0);
    if (tonNano <= 0n || !instruction?.recipient) {
      throw new Error('invalid GRAM refund instruction (recipient and positive tonNano required)');
    }
    const memo = instruction.memo || (instruction.queryId ? `refund:${instruction.queryId}` : '');
    const env = {
      ...withActonNetworkKeyEnv(network, baseEnv),
      OPS_EXECUTE: 'true',
      A9_NETWORK: network,
      A9_PRESALE_HOT_WALLET_NAME: hotWalletName,
      ...(expectedHotWalletAddress ? { A9_EXPECTED_HOT_WALLET_ADDRESS: expectedHotWalletAddress } : {}),
      A9_REFUND_RECIPIENT: instruction.recipient,
      A9_REFUND_TON_NANO: tonNano.toString(),
      A9_REFUND_MEMO: memo,
    };

    const stdout = await runActonScript({ network, scriptRelPath: scriptPath, cwd: projectRoot, env, spawnImpl });
    const match = stdout.match(/GRAM_REFUND_TX=(0x[0-9a-fA-F]+)/);
    if (!match) {
      throw new Error('acton GRAM refund completed without emitting GRAM_REFUND_TX hash');
    }
    return { txHash: normalizeFullTxHashHex(match[1]) };
  };
}
