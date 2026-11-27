// Read-only deployment checks. No signing, persistence, or network fallback.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { OPS_ROOT, validateDeployPreflight, withActonNetworkKeyEnv } from './v15-core.mjs';
import { normalizeTonAddress, parseTonAddress } from '../../../worker/src/ton-address.mjs';
import { parseBoc, parseStateInit, inspectWalletStateInit } from '../../../worker/src/ton-cell.mjs';

export const LOCKED_BUNDLE_PATH = resolve(OPS_ROOT, 'deploy-console/bundle-mainnet-v17.0.json');
export const LOCKED_BUNDLE_SHA256 = 'e8ebd1ead7f51d77918a353bb4d7c6704c818c2a74a25f984ce71c51bb9d3fd6';
// Canonical zero-state identities, from https://ton.org/{global-config.json,testnet-global.config.json}.
export const ZERO_STATES = Object.freeze({
  mainnet: 'F6OpKZKqvqeFp6CQmFomXNMfMj2EnaUSOXN+Mh+wVWk=',
  testnet: 'gj+B8wb/AmlPk1z1AhVI484rhrUpgSr2oSFIh56VoSg=',
});
export const SIGNER_ROLES = Object.freeze(['deployer', 'treasury', 'keeper', 'roundOpener', 'teamWallet', 'presaleHotWallet', 'promoHotWallet']);
const fail = (code) => { throw new Error(code); };
const sameAddress = (a, b) => Boolean(normalizeTonAddress(a) && normalizeTonAddress(a) === normalizeTonAddress(b));
const hashHex = (h) => {
  if (typeof h !== 'string') return null;
  if (/^[a-fA-F0-9]{64}$/.test(h)) return h.toLowerCase();
  if (!/^[A-Za-z0-9+/_-]{43}=?$/.test(h)) return null;
  const b = Buffer.from(h, 'base64url');
  return b.length === 32 ? b.toString('hex') : null;
};

export async function probeRpc({ network, env = process.env, fetchImpl = globalThis.fetch, timeoutMs = 10000 }) {
  const key = String(env[network === 'mainnet' ? 'TONCENTER_MAINNET_API_KEY' : 'TONCENTER_TESTNET_API_KEY'] || env.TONCENTER_API_KEY || '').trim();
  if (network === 'mainnet' && !key) fail('RPC_KEY_MISSING');
  const raw = env.TONCENTER_API_BASE || (network === 'mainnet' ? 'https://toncenter.com/api/v2' : 'https://testnet.toncenter.com/api/v2');
  let url;
  try { url = new URL(raw); } catch { fail('RPC_URL_INVALID'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) fail('RPC_URL_INVALID');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`${url.href.replace(/\/+$/, '')}/getMasterchainInfo`, {
      method: 'GET', redirect: 'error', signal: controller.signal,
      headers: { ...(key ? { 'X-API-Key': key } : {}) },
    });
    if (!res.ok) fail(`RPC_HTTP_${Number(res.status)}`);
    const body = await res.json();
    if (body?.ok !== true || !body.result || body.result.init?.workchain !== -1
      || !Number.isInteger(body.result.last?.seqno) || body.result.last.seqno <= 0
      || body.result.last?.workchain !== -1) fail('RPC_RESPONSE_INVALID');
    if (!hashHex(body.result.init.root_hash) || hashHex(body.result.init.root_hash) !== hashHex(ZERO_STATES[network])) fail('RPC_NETWORK_MISMATCH');
    return { ok: true, network, lastSeqno: body.result.last.seqno };
  } catch (e) {
    if (/^RPC_[A-Z_0-9]+$/.test(e?.message || '')) throw e;
    // Never include transport errors, URLs, or headers which may echo credentials.
    fail(controller.signal.aborted ? 'RPC_TIMEOUT' : 'RPC_UNAVAILABLE');
  } finally { clearTimeout(timer); }
}

export async function verifyLockedBundle({ params, protocolRoot, artifacts, readFile = readFileSync } = {}) {
  const bytes = readFile(LOCKED_BUNDLE_PATH);
  if (createHash('sha256').update(bytes).digest('hex') !== LOCKED_BUNDLE_SHA256) fail('BUNDLE_FINGERPRINT_MISMATCH');
  const bundle = JSON.parse(String(bytes));
  if (bundle.network !== 'mainnet' || bundle.chainId !== '-239' || bundle.protocolVersion !== '17.0.0') fail('BUNDLE_NETWORK_OR_PROTOCOL_MISMATCH');
  if (JSON.stringify(bundle.timing) !== JSON.stringify(params.timing)
    || Object.keys(params.supply).some((k) => String(bundle.supply?.[k]) !== String(params.supply[k]))) fail('BUNDLE_PARAMETERS_MISMATCH');
  if (artifacts.some((a) => !bundle.artifactsSha256.some((b) => b.relPath === a.relPath && b.sha256 === a.sha256))) fail('BUNDLE_ARTIFACT_MISMATCH');
  for (const role of SIGNER_ROLES) {
    const parsed = parseTonAddress(bundle.roles?.[role]);
    if (!parsed || parsed.workchain !== 0 || parsed.testOnly === true) fail(`BUNDLE_ROLE_INVALID_${role}`);
  }
  const derived = {};
  for (const [name, stepId, artifactName] of [
    ['jettonMaster', 'deploy-jetton-master', 'JettonMaster'],
    ['roundController', 'deploy-round-controller', 'RoundController'],
  ]) {
    const step = bundle.steps.find((s) => s.id === stepId);
    const roots = parseBoc(step?.message?.stateInit);
    if (roots.length !== 1) fail(`BUNDLE_STATE_INIT_INVALID_${name}`);
    const { code } = parseStateInit(roots[0]);
    const artifact = JSON.parse(readFile(resolve(protocolRoot, 'build', `${artifactName}.json`), 'utf8'));
    const codeRoots = parseBoc(artifact.code_boc64);
    if (codeRoots.length !== 1 || await code.hashHex() !== await codeRoots[0].hashHex()) fail(`BUNDLE_CODE_MISMATCH_${name}`);
    derived[name] = `0:${await roots[0].hashHex()}`;
    if (!sameAddress(derived[name], bundle.contracts[name]) || !sameAddress(derived[name], step.message.address)) fail(`BUNDLE_STATE_INIT_ADDRESS_MISMATCH_${name}`);
  }
  return { bundle, derived };
}

// The inspector prints public addresses only. It must never call wallet.sign()/net.send().
export function inspectLocalSigners({ signers, network, protocolRoot, env, spawnImpl = spawnSync }) {
  const local = Object.entries(signers).filter(([, s]) => s?.mode === 'local');
  if (!local.length) return {};
  const names = {};
  for (const [role, s] of local) {
    if (!SIGNER_ROLES.includes(role) || !/^[A-Za-z0-9._-]+$/.test(s.walletName || '')) fail(`SIGNER_NAME_INVALID_${role}`);
    names[`A9_INSPECT_${role}`] = s.walletName;
  }
  const res = spawnImpl('acton', ['script', '--net', network, '../ops/tolk/inspect_signers.tolk'], {
    cwd: protocolRoot, encoding: 'utf8', timeout: 30000,
    env: { ...withActonNetworkKeyEnv(network, env), ...names, OPS_EXECUTE: 'false', OPS_CONFIRM: '', OPS_CONFIRM_MAINNET: '' },
  });
  if (res.status !== 0 || !String(res.stdout).includes('A9_SIGNERS_READ_ONLY_OK')) fail('SIGNER_LOCAL_RESOLUTION_FAILED');
  const out = {};
  for (const [role] of local) {
    const matches = [...String(res.stdout).matchAll(new RegExp(`^SIGNER_${role}\\s*=\\s*(\\S+)\\s*$`, 'gm'))];
    if (matches.length !== 1 || !normalizeTonAddress(matches[0][1])) fail(`SIGNER_LOCAL_RESULT_INVALID_${role}`);
    out[role] = matches[0][1];
  }
  return out;
}

export async function verifySignerSources({ manifest, bundle, env, protocolRoot, spawnImpl }) {
  if (!manifest || manifest.network !== 'mainnet' || !manifest.roles) fail('SIGNER_MANIFEST_REQUIRED');
  const localAddresses = inspectLocalSigners({ signers: manifest.roles, network: 'mainnet', protocolRoot, env, spawnImpl });
  const checked = {};
  for (const role of SIGNER_ROLES) {
    const s = manifest.roles[role];
    if (!s || !sameAddress(s.address, bundle.roles[role])) fail(`SIGNER_SOURCE_MISSING_OR_MISMATCH_${role}`);
    if (s.mode === 'local') {
      if (!sameAddress(localAddresses[role], s.address)) fail(`SIGNER_LOCAL_ADDRESS_MISMATCH_${role}`);
    } else if (['tonconnect', 'hardware', 'multisig'].includes(s.mode)) {
      if (typeof s.source !== 'string' || !s.source.trim() || !s.stateInit) fail(`SIGNER_EXTERNAL_DESCRIPTOR_REQUIRED_${role}`);
      const info = await inspectWalletStateInit(s.stateInit);
      if (!sameAddress(`0:${info.addressHashHex}`, s.address)) fail(`SIGNER_EXTERNAL_STATE_INIT_MISMATCH_${role}`);
      if (s.mode !== 'multisig' && info.walletKind !== 'standard') fail(`SIGNER_EXTERNAL_VERSION_UNSUPPORTED_${role}`);
      if (s.version && s.version !== info.version) fail(`SIGNER_EXTERNAL_VERSION_MISMATCH_${role}`);
      if (info.version === 'v5r1') {
        if (info.isSignatureAllowed !== true) fail(`SIGNER_EXTERNAL_SIGNATURE_DISABLED_${role}`);
        const expectedChain = manifest.network === 'mainnet' ? '-239' : '-3';
        if (info.chainId !== expectedChain) fail(`SIGNER_EXTERNAL_WALLET_NETWORK_MISMATCH_${role}`);
      }
    } else fail(`SIGNER_MODE_INVALID_${role}`);
    checked[role] = { mode: s.mode, address: normalizeTonAddress(s.address) };
  }
  return checked;
}

export async function checkDeploymentReadiness({
  protocol = 'v17', profile = 'testnet', env = process.env, execute = false,
  deploymentMode = 'local', signerManifest = null, fetchImpl = globalThis.fetch,
  spawnImpl = spawnSync, rpcTimeoutMs = 10000,
} = {}) {
  const errors = [];
  const checks = { static: false, rpc: false, bundle: false, signers: false, metadata: false };
  const external = deploymentMode === 'external';
  let preflight;
  try {
    preflight = validateDeployPreflight({ protocol, profile, env, strict: false, execute: false, spawnImpl,
      resolveWallets: !external, requireDeployWalletNames: !external });
  } catch {
    return { readyForExecute: false, readyForExternalDeployment: false, checks, errors: ['STATIC_PREFLIGHT_FAILED'] };
  }
  errors.push(...preflight.missing, ...preflight.invalid);
  checks.static = errors.length === 0;
  if (!['local', 'external'].includes(deploymentMode)) errors.push('DEPLOYMENT_MODE_INVALID');
  let rpc = null;
  try { rpc = await probeRpc({ network: preflight.params.network, env, fetchImpl, timeoutMs: rpcTimeoutMs }); checks.rpc = true; }
  catch (e) { errors.push(e.message); }
  let bundle = null;
  let signerSources = null;
  if (preflight.params.network === 'mainnet') {
    if (protocol !== 'v17') errors.push('MAINNET_REQUIRES_V17_LOCKED_BUNDLE');
    else {
      try {
        const verified = await verifyLockedBundle(preflight);
        bundle = verified.bundle;
        if (env.A9_METADATA_URI !== bundle.metadataUri) fail('BUNDLE_METADATA_MISMATCH');
        for (const [role, key] of [['keeper', 'A9_KEEPER_ADDRESS'], ['roundOpener', 'A9_ROUND_OPENER_ADDRESS'], ['teamWallet', 'A9_TEAM_WALLET_ADDRESS']]) {
          const address = env[key] || (role === 'roundOpener' ? env.A9_KEEPER_ADDRESS : null);
          if (!sameAddress(address, bundle.roles[role])) fail(`BUNDLE_ROLE_MISMATCH_${role}`);
        }
        if (!external) {
          for (const role of ['deployer', 'treasury']) if (!sameAddress(preflight.derivedAddresses?.[role], bundle.roles[role])) fail(`BUNDLE_DERIVED_WALLET_MISMATCH_${role}`);
          for (const name of ['jettonMaster', 'roundController']) if (!sameAddress(preflight.derivedAddresses?.[name], bundle.contracts[name])) fail(`BUNDLE_DERIVED_CONTRACT_MISMATCH_${name}`);
        }
        checks.bundle = true;
      } catch (e) { errors.push(/^BUNDLE_/.test(e.message) ? e.message : 'BUNDLE_VALIDATION_FAILED'); }
    }
    if (bundle) {
      try {
        signerSources = await verifySignerSources({ manifest: signerManifest, bundle, env, protocolRoot: preflight.protocolRoot, spawnImpl });
        if (!external) for (const [role, key] of [['deployer', 'A9_DEPLOY_WALLET'], ['treasury', 'A9_TREASURY_WALLET']]) {
          if (signerManifest.roles[role].mode !== 'local' || signerManifest.roles[role].walletName !== env[key]) fail(`SIGNER_CLI_MODE_MISMATCH_${role}`);
        }
        checks.signers = true;
      } catch (e) { errors.push(/^SIGNER_/.test(e.message) ? e.message : 'SIGNER_VALIDATION_FAILED'); }
    }
  } else {
    checks.bundle = !external;
    checks.signers = !external && Boolean(preflight.derivedAddresses);
    if (external) errors.push('EXTERNAL_MODE_REQUIRES_MAINNET_BUNDLE');
  }
  try {
    const url = new URL(env.A9_METADATA_URI);
    if (url.protocol !== 'https:' || url.username || url.password) fail('METADATA_HTTPS_REQUIRED');
    const response = await fetchImpl(url.href, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(rpcTimeoutMs) });
    if (!response.ok) fail('METADATA_UNAVAILABLE');
    const meta = await response.json();
    if (meta?.symbol !== 'A9' || String(meta.decimals) !== '9' || typeof meta.name !== 'string' || !meta.name.trim()) fail('METADATA_INVALID');
    const image = new URL(meta.image);
    if (image.protocol !== 'https:' || image.username || image.password) fail('METADATA_IMAGE_INVALID');
    const img = await fetchImpl(image.href, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(rpcTimeoutMs) });
    if (!img.ok || !String(img.headers?.get('content-type') || '').startsWith('image/')) fail('METADATA_IMAGE_UNAVAILABLE');
    await img.body?.cancel?.();
    checks.metadata = true;
  } catch (e) { errors.push(/^METADATA_/.test(e.message) ? e.message : 'METADATA_PROBE_FAILED'); }
  if (execute && (env.OPS_EXECUTE !== '1' || env.OPS_CONFIRM !== 'YES'
    || (preflight.params.network === 'mainnet' && env.OPS_CONFIRM_MAINNET !== 'YES'))) errors.push('EXECUTION_CONFIRMATION_REQUIRED');
  if (execute && external) errors.push('EXTERNAL_DEPLOYMENT_REQUIRES_CONSOLE');
  const passed = Object.values(checks).every(Boolean) && errors.length === 0;
  return {
    ...preflight, readyForExecute: passed && !external, readyForExternalDeployment: passed && external,
    readyForPayouts: passed && ['presaleHotWallet', 'promoHotWallet'].every((r) => signerSources?.[r]?.mode === 'local'),
    deploymentMode, checks, errors, rpc, signerSources,
  };
}
