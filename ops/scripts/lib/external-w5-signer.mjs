// A9 协议 v17 — 外部 W5 (v5r1) 运维签名流程状态机（零私钥、默认 dry-run、真链规范化 BoC 确认、原子互斥与存储层版本控制）。
// 状态机：PREPARED -> AWAITING_EXTERNAL_SIGNATURE -> SIGNED_SUBMITTED / PENDING_CHAIN_VERIFICATION -> CONFIRMED
// 安全红线：
// 1. 严格绑定并二次核对：chainId(-239/-3)、公开钱包地址、W5 StateInit、seqno、validUntil、目标合约、金额、规范化 payloadCellHash。
// 2. 禁止仅凭 { confirmed: true } 或钱包回调哈希推进 CONFIRMED；必须通过独立链回读校验：
//    实际签名请求的 signedSeqno/signedValidUntil、交易时间窗 [createdAt, validUntil]、
//    钱包出站消息与目标入站消息的 msgHash 关联、精确金额（=== amountNano）、规范化 BoC 根 Cell 哈希与双边执行成功。
// 3. ExternalW5SessionStore 强制状态机转换规则（CONFIRMED/REJECTED 终态不可回退），版本递增完全由存储层控制，
//    同版本不同内容或旧分支覆盖一律抛 STATE_VERSION_CONFLICT；原子写入 + O_EXCL 进程互斥锁。
// 4. 绝不修改锁定部署包 ops/deploy-console/bundle-mainnet-v17.0.json；保留 keeper/roundOpener 合设待业主签认。
import { createHash, randomBytes } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { normalizeTonAddress, parseTonAddress } from '../../../worker/src/ton-address.mjs';
import { inspectWalletStateInit, parseBoc } from '../../../worker/src/ton-cell.mjs';
import { LOCKED_BUNDLE_PATH, LOCKED_BUNDLE_SHA256, SIGNER_ROLES } from './deploy-readiness.mjs';

export const EXTERNAL_W5_PACKAGE_VERSION = 'a9-v17-external-w5-sign-pkg-v2';

export const W5_STATES = Object.freeze({
  PREPARED: 'PREPARED',
  VERIFIED: 'VERIFIED',
  AWAITING_EXTERNAL_SIGNATURE: 'AWAITING_EXTERNAL_SIGNATURE',
  SIGNED_SUBMITTED: 'SIGNED_SUBMITTED',
  PENDING_CHAIN_VERIFICATION: 'PENDING_CHAIN_VERIFICATION',
  CONFIRMED: 'CONFIRMED',
  REJECTED: 'REJECTED',
});

export const ALLOWED_W5_TRANSITIONS = Object.freeze({
  [W5_STATES.PREPARED]: [W5_STATES.AWAITING_EXTERNAL_SIGNATURE, W5_STATES.REJECTED],
  [W5_STATES.AWAITING_EXTERNAL_SIGNATURE]: [W5_STATES.SIGNED_SUBMITTED, W5_STATES.PENDING_CHAIN_VERIFICATION, W5_STATES.REJECTED],
  [W5_STATES.SIGNED_SUBMITTED]: [W5_STATES.PENDING_CHAIN_VERIFICATION, W5_STATES.CONFIRMED],
  [W5_STATES.PENDING_CHAIN_VERIFICATION]: [W5_STATES.PENDING_CHAIN_VERIFICATION, W5_STATES.CONFIRMED],
  [W5_STATES.CONFIRMED]: [],
  [W5_STATES.REJECTED]: [],
});

export class ExternalW5Error extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function canonicalStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((x) => canonicalStringify(x)).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalStringify(value[k])}`).join(',')}}`;
}

export function sha256Hex(input) {
  const data = typeof input === 'string' || Buffer.isBuffer(input) ? input : canonicalStringify(input);
  return `0x${createHash('sha256').update(data).digest('hex')}`;
}

/**
 * 规范化 BoC 根 Cell 哈希（与外层 base64/CRC/index 编码方式无关，用于链上消息内容精准比对）。
 */
export async function canonicalBocCellHashHex(bocBase64) {
  if (typeof bocBase64 !== 'string' || !bocBase64.trim()) {
    throw new ExternalW5Error('INVALID_PAYLOAD_BOC', 'BoC string is required');
  }
  let roots;
  try {
    roots = parseBoc(bocBase64.trim());
  } catch (e) {
    throw new ExternalW5Error('INVALID_PAYLOAD_BOC', `failed to parse BoC: ${e?.message || e}`);
  }
  if (!Array.isArray(roots) || roots.length !== 1) {
    throw new ExternalW5Error('INVALID_PAYLOAD_BOC', 'BoC must contain exactly 1 root cell');
  }
  return `0x${(await roots[0].hashHex()).toLowerCase()}`;
}

function sameAddress(a, b) {
  const na = normalizeTonAddress(a);
  const nb = normalizeTonAddress(b);
  return Boolean(na && nb && na === nb);
}

function assertExpectedChain(network, chainId) {
  const net = String(network || '').trim().toLowerCase();
  const cid = String(chainId || '').trim();
  if (net === 'mainnet' && cid !== '-239') {
    throw new ExternalW5Error('WRONG_CHAIN', `mainnet requires chainId=-239, got "${cid}"`);
  }
  if (net === 'testnet' && cid !== '-3') {
    throw new ExternalW5Error('WRONG_CHAIN', `testnet requires chainId=-3, got "${cid}"`);
  }
  if (net !== 'mainnet' && net !== 'testnet') {
    throw new ExternalW5Error('WRONG_CHAIN', `unsupported network "${network}"`);
  }
  return { network: net, chainId: cid };
}

/**
 * 核验外部 W5 钱包 StateInit 与公开地址、网络、签名能力完全匹配。
 */
export async function verifyExternalW5Wallet({
  signerAddress,
  walletStateInit,
  expectedChainId,
  expectedVersion = 'v5r1',
}) {
  const addr = String(signerAddress || '').trim();
  const parsed = parseTonAddress(addr);
  if (!parsed || parsed.workchain !== 0) {
    throw new ExternalW5Error('INVALID_WALLET_ADDRESS', `signerAddress must be valid basechain TON address: "${addr}"`);
  }
  if (expectedChainId === '-239' && parsed.testOnly === true) {
    throw new ExternalW5Error('WRONG_CHAIN', `testnet-only signerAddress cannot be used on chain -239: "${addr}"`);
  }
  if (!walletStateInit || typeof walletStateInit !== 'string') {
    throw new ExternalW5Error('MISSING_STATE_INIT', 'walletStateInit BoC is required for external W5 signing');
  }
  let info;
  try {
    info = await inspectWalletStateInit(walletStateInit);
  } catch (e) {
    throw new ExternalW5Error('INVALID_STATE_INIT', `failed to inspect wallet StateInit: ${e?.message || e}`);
  }
  if (info.version !== expectedVersion) {
    throw new ExternalW5Error('WRONG_WALLET_VERSION', `expected wallet version ${expectedVersion}, got ${info.version}`);
  }
  if (info.isSignatureAllowed !== true) {
    throw new ExternalW5Error('SIGNATURE_DISABLED', 'W5 wallet StateInit has isSignatureAllowed=false');
  }
  if (String(info.chainId) !== String(expectedChainId)) {
    throw new ExternalW5Error(
      'WRONG_CHAIN',
      `W5 StateInit chainId (${info.chainId}) does not match expected chainId (${expectedChainId})`,
    );
  }
  const derivedRaw = `0:${info.addressHashHex}`;
  if (!sameAddress(derivedRaw, addr)) {
    throw new ExternalW5Error(
      'STATE_INIT_ADDRESS_MISMATCH',
      `W5 StateInit derived address (${derivedRaw}) does not match signerAddress (${addr})`,
    );
  }
  return {
    ok: true,
    version: info.version,
    chainId: String(info.chainId),
    derivedRaw,
    stateInitSha256: sha256Hex(walletStateInit),
  };
}

/**
 * 阶段 1：准备外部 W5 待签包（默认 dry-run，绝不广播）。
 */
export async function prepareExternalW5Package({
  network = 'mainnet',
  chainId = network === 'mainnet' ? '-239' : '-3',
  action,
  role,
  signerAddress,
  walletStateInit,
  seqno,
  validUntil,
  targetContract,
  amountNano,
  payloadBoc,
  metadata = {},
  nowSec = Math.floor(Date.now() / 1000),
}) {
  const { network: net, chainId: cid } = assertExpectedChain(network, chainId);
  const cleanAction = String(action || '').trim();
  if (!cleanAction) throw new ExternalW5Error('INVALID_ACTION', 'action is required');
  const cleanRole = String(role || '').trim();
  if (!SIGNER_ROLES.includes(cleanRole)) {
    throw new ExternalW5Error('INVALID_ROLE', `unsupported signer role: "${cleanRole}"`);
  }
  const walletCheck = await verifyExternalW5Wallet({
    signerAddress,
    walletStateInit,
    expectedChainId: cid,
  });

  const targetParsed = parseTonAddress(String(targetContract || '').trim());
  if (!targetParsed || targetParsed.workchain !== 0) {
    throw new ExternalW5Error('INVALID_TARGET', `invalid targetContract: "${targetContract}"`);
  }
  if (cid === '-239' && targetParsed.testOnly === true) {
    throw new ExternalW5Error('WRONG_CHAIN', 'targetContract cannot be a testnet-only address on mainnet');
  }

  if (!Number.isInteger(seqno) || seqno < 0) {
    throw new ExternalW5Error('INVALID_SEQNO', `seqno must be a non-negative integer, got ${seqno}`);
  }
  if (!Number.isSafeInteger(nowSec) || nowSec <= 0 || !Number.isSafeInteger(validUntil) || validUntil <= nowSec) {
    throw new ExternalW5Error('EXPIRED_PACKAGE', `validUntil (${validUntil}) must be > nowSec (${nowSec})`);
  }
  let amountBig;
  try {
    amountBig = BigInt(String(amountNano ?? '0'));
  } catch {
    throw new ExternalW5Error('INVALID_AMOUNT', `amountNano must be integer string, got ${amountNano}`);
  }
  if (amountBig <= 0n) {
    throw new ExternalW5Error('INVALID_AMOUNT', 'amountNano must be > 0');
  }
  const cleanPayload = String(payloadBoc || '').trim();
  if (!cleanPayload) {
    throw new ExternalW5Error('MISSING_PAYLOAD', 'payloadBoc is required');
  }
  const payloadCellHash = await canonicalBocCellHashHex(cleanPayload);
  const payloadSha256 = sha256Hex(cleanPayload);

  const core = {
    version: EXTERNAL_W5_PACKAGE_VERSION,
    createdAt: nowSec,
    network: net,
    chainId: cid,
    action: cleanAction,
    role: cleanRole,
    signerAddress: String(signerAddress).trim(),
    signerRaw: walletCheck.derivedRaw,
    walletVersion: walletCheck.version,
    walletStateInit: String(walletStateInit).trim(),
    walletStateInitSha256: walletCheck.stateInitSha256,
    seqno,
    validUntil,
    targetContract: String(targetContract).trim(),
    targetContractRaw: normalizeTonAddress(String(targetContract).trim()),
    amountNano: amountBig.toString(),
    payloadBoc: cleanPayload,
    payloadCellHash,
    payloadSha256,
    metadata,
  };
  const packageHash = sha256Hex(core);
  const packageId = `w5pkg_${packageHash.slice(2, 18)}`;

  return {
    packageId,
    packageHash,
    state: W5_STATES.PREPARED,
    stateVersion: 1,
    dryRun: true,
    updatedAt: Number(nowSec),
    history: [{ at: Number(nowSec), state: W5_STATES.PREPARED, note: 'prepared unsigned W5 package' }],
    submission: null,
    confirmation: null,
    ...core,
  };
}

function assertPackageIntegrity(pkg) {
  const {
    packageId: _pid,
    packageHash,
    state: _st,
    stateVersion: _sv,
    dryRun: _dr,
    updatedAt: _ua,
    history: _h,
    submission: _sub,
    confirmation: _conf,
    ...core
  } = pkg;
  if (sha256Hex(core) !== packageHash || _pid !== `w5pkg_${packageHash.slice(2, 18)}`) {
    throw new ExternalW5Error('PACKAGE_TAMPERED', 'packageHash mismatch: signing package was modified');
  }
}

/**
 * 阶段 2：签名前二次核对（包含规范化 payloadCellHash 校验）。
 */
export async function verifyPackageBeforeSign(pkg, {
  expectedNetwork = pkg?.network,
  expectedChainId = pkg?.chainId,
  expectedSignerAddress = pkg?.signerAddress,
  expectedTargetContract = pkg?.targetContract,
  currentChainSeqno,
  nowSec = Math.floor(Date.now() / 1000),
} = {}) {
  if (!pkg || pkg.version !== EXTERNAL_W5_PACKAGE_VERSION) {
    throw new ExternalW5Error('INVALID_PACKAGE', 'unsupported or missing W5 signing package');
  }
  if (pkg.state === W5_STATES.CONFIRMED) {
    throw new ExternalW5Error('ALREADY_CONFIRMED', `package ${pkg.packageId} is already CONFIRMED`);
  }
  if (pkg.state === W5_STATES.PENDING_CHAIN_VERIFICATION || pkg.state === W5_STATES.SIGNED_SUBMITTED) {
    throw new ExternalW5Error(
      'AMBIGUOUS_REQUIRES_CHAIN_CHECK',
      `package ${pkg.packageId} is in ${pkg.state}; refusing to re-sign before independent chain verification`,
    );
  }

  assertPackageIntegrity(pkg);
  if (sha256Hex(pkg.payloadBoc) !== pkg.payloadSha256) {
    throw new ExternalW5Error('PAYLOAD_TAMPERED', 'payloadBoc does not match bound payloadSha256');
  }
  if ((await canonicalBocCellHashHex(pkg.payloadBoc)) !== pkg.payloadCellHash) {
    throw new ExternalW5Error('PAYLOAD_TAMPERED', 'payloadBoc canonical root cell hash mismatch');
  }

  assertExpectedChain(expectedNetwork, expectedChainId);
  if (pkg.network !== expectedNetwork || String(pkg.chainId) !== String(expectedChainId)) {
    throw new ExternalW5Error(
      'WRONG_CHAIN',
      `package chain (${pkg.network}/${pkg.chainId}) != expected (${expectedNetwork}/${expectedChainId})`,
    );
  }
  if (!sameAddress(pkg.signerAddress, expectedSignerAddress)) {
    throw new ExternalW5Error(
      'WRONG_WALLET',
      `package signerAddress (${pkg.signerAddress}) != expected (${expectedSignerAddress})`,
    );
  }
  if (!sameAddress(pkg.targetContract, expectedTargetContract)) {
    throw new ExternalW5Error(
      'WRONG_TARGET',
      `package targetContract (${pkg.targetContract}) != expected (${expectedTargetContract})`,
    );
  }

  await verifyExternalW5Wallet({
    signerAddress: pkg.signerAddress,
    walletStateInit: pkg.walletStateInit,
    expectedChainId: String(expectedChainId),
  });

  if (!Number.isSafeInteger(nowSec) || nowSec < pkg.createdAt || nowSec >= pkg.validUntil) {
    throw new ExternalW5Error('EXPIRED_PACKAGE', `package expired at ${pkg.validUntil} (now=${nowSec})`);
  }
  if (!Number.isInteger(currentChainSeqno) || currentChainSeqno < 0) {
    throw new ExternalW5Error('MISSING_CHAIN_SEQNO', 'currentChainSeqno integer is required before signing');
  }
  if (currentChainSeqno !== pkg.seqno) {
    throw new ExternalW5Error(
      'STALE_SEQNO',
      `package seqno (${pkg.seqno}) != current on-chain seqno (${currentChainSeqno})`,
    );
  }

  return {
    ...pkg,
    state: W5_STATES.AWAITING_EXTERNAL_SIGNATURE,
    stateVersion: Number(pkg.stateVersion || 1) + 1,
    updatedAt: Number(nowSec),
    history: [
      ...pkg.history,
      { at: Number(nowSec), state: W5_STATES.VERIFIED, note: 'pre-sign verification passed' },
      { at: Number(nowSec), state: W5_STATES.AWAITING_EXTERNAL_SIGNATURE, note: 'ready for external W5 signing' },
    ],
  };
}

/**
 * 阶段 3：记录外部签名/广播回调（绝不把回调当作链上确认）。
 */
export function recordExternalSignCallback(pkg, callback, nowSec = Math.floor(Date.now() / 1000)) {
  if (!pkg || pkg.version !== EXTERNAL_W5_PACKAGE_VERSION) {
    throw new ExternalW5Error('INVALID_PACKAGE', 'invalid W5 signing package');
  }
  assertPackageIntegrity(pkg);
  if (pkg.state === W5_STATES.CONFIRMED) {
    throw new ExternalW5Error('ALREADY_CONFIRMED', `package ${pkg.packageId} is already CONFIRMED`);
  }
  if (pkg.state === W5_STATES.SIGNED_SUBMITTED || pkg.state === W5_STATES.PENDING_CHAIN_VERIFICATION) {
    throw new ExternalW5Error(
      'DUPLICATE_CALLBACK',
      `package ${pkg.packageId} already recorded callback in state ${pkg.state}; run chain verification instead`,
    );
  }
  if (pkg.state !== W5_STATES.AWAITING_EXTERNAL_SIGNATURE) {
    throw new ExternalW5Error('INVALID_STATE_TRANSITION', `cannot record callback from state ${pkg.state}`);
  }
  if (!callback || typeof callback !== 'object') {
    throw new ExternalW5Error('INVALID_CALLBACK', 'callback object is required');
  }
  if (String(callback.packageId || '') !== pkg.packageId) {
    throw new ExternalW5Error('CALLBACK_MISMATCH', 'callback packageId mismatch');
  }
  if (String(callback.chainId || '') !== String(pkg.chainId)) {
    throw new ExternalW5Error('WRONG_CHAIN', `callback chainId (${callback.chainId}) != package (${pkg.chainId})`);
  }
  if (!sameAddress(callback.signerAddress, pkg.signerAddress)) {
    throw new ExternalW5Error('WRONG_WALLET', 'callback signerAddress mismatch');
  }
  if (Number(callback.seqno) !== pkg.seqno) {
    throw new ExternalW5Error('STALE_SEQNO', `callback seqno (${callback.seqno}) != package (${pkg.seqno})`);
  }
  if (String(callback.payloadSha256 || '') !== pkg.payloadSha256) {
    throw new ExternalW5Error('PAYLOAD_TAMPERED', 'callback payloadSha256 mismatch');
  }

  const outcome = String(callback.outcome || '').trim().toLowerCase();
  const nextVersion = Number(pkg.stateVersion || 1) + 1;
  if (outcome === 'rejected') {
    return {
      ...pkg,
      state: W5_STATES.REJECTED,
      stateVersion: nextVersion,
      updatedAt: Number(nowSec),
      submission: { outcome: 'rejected', reason: String(callback.reason || 'user_rejected'), at: Number(nowSec) },
      history: [...pkg.history, { at: Number(nowSec), state: W5_STATES.REJECTED, note: 'external signer rejected' }],
    };
  }
  if (outcome === 'timeout' || outcome === 'ambiguous') {
    return {
      ...pkg,
      state: W5_STATES.PENDING_CHAIN_VERIFICATION,
      stateVersion: nextVersion,
      updatedAt: Number(nowSec),
      submission: {
        outcome,
        txHash: callback.txHash ? String(callback.txHash).trim() : null,
        at: Number(nowSec),
        autoResignForbidden: true,
      },
      history: [
        ...pkg.history,
        { at: Number(nowSec), state: W5_STATES.PENDING_CHAIN_VERIFICATION, note: `callback ${outcome}; independent chain check required` },
      ],
    };
  }
  if (outcome === 'submitted') {
    const txHash = String(callback.txHash || '').trim();
    if (!txHash) {
      throw new ExternalW5Error('INVALID_CALLBACK', 'submitted callback requires txHash');
    }
    return {
      ...pkg,
      state: W5_STATES.SIGNED_SUBMITTED,
      stateVersion: nextVersion,
      updatedAt: Number(nowSec),
      submission: { outcome: 'submitted', txHash, at: Number(nowSec), autoResignForbidden: true },
      history: [
        ...pkg.history,
        { at: Number(nowSec), state: W5_STATES.SIGNED_SUBMITTED, note: `submitted txHash=${txHash}` },
      ],
    };
  }
  throw new ExternalW5Error('INVALID_CALLBACK', `unsupported callback outcome: "${callback.outcome}"`);
}

/**
 * 独立校验链上交易证据：严格绑定本次签名包，拒绝历史旧交易、其他交易推进 seqno、不相关目标交易与不精确金额。
 * - 核验 chainId、walletSeqnoAfter > seqno；
 * - 核验实际签名请求绑定：walletTx.signedSeqno === pkg.seqno、walletTx.signedValidUntil === pkg.validUntil、
 *   以及交易时间 walletTx.now 落在 [pkg.createdAt, pkg.validUntil] 内；
 * - 核验钱包出站消息与目标入站消息通过 msgHash 强关联（matchedOut.msgHash === targetTx.inMsgHash）且 targetTx.lt >= walletTx.lt；
 * - 核验精确金额（BigInt === BigInt(pkg.amountNano)）；
 * - 核验规范化 BoC 根 Cell 哈希（canonicalBocCellHashHex === pkg.payloadCellHash）。
 */
export async function verifyOnChainW5Evidence(pkg, evidence) {
  if (!evidence || typeof evidence !== 'object') {
    return { ok: false, reason: 'MISSING_CHAIN_EVIDENCE' };
  }
  if (String(evidence.chainId || '') !== String(pkg.chainId)) {
    return { ok: false, reason: 'CHAIN_ID_MISMATCH' };
  }
  if (!Number.isInteger(evidence.walletSeqnoAfter) || evidence.walletSeqnoAfter <= pkg.seqno) {
    return { ok: false, reason: 'WALLET_SEQNO_NOT_ADVANCED' };
  }

  const wtx = evidence.walletTx;
  if (!wtx || typeof wtx !== 'object' || !String(wtx.hash || '').trim() || !String(wtx.lt || '').trim()) {
    return { ok: false, reason: 'MISSING_WALLET_TX' };
  }
  if (!sameAddress(wtx.account, pkg.signerRaw)) {
    return { ok: false, reason: 'WALLET_TX_ACCOUNT_MISMATCH' };
  }
  // 强制校验本次签名包的 seqno、validUntil 与链上交易时间窗（拒绝历史相同 payload 与其他交易推进 seqno）
  if (!Number.isInteger(wtx.signedSeqno) || wtx.signedSeqno !== pkg.seqno) {
    return { ok: false, reason: 'SIGNED_SEQNO_MISMATCH' };
  }
  if (!Number.isInteger(wtx.signedValidUntil) || wtx.signedValidUntil !== pkg.validUntil) {
    return { ok: false, reason: 'SIGNED_VALID_UNTIL_MISMATCH' };
  }
  if (!Number.isInteger(wtx.now) || wtx.now < pkg.createdAt || wtx.now > pkg.validUntil) {
    return { ok: false, reason: 'WALLET_TX_TIME_OUT_OF_WINDOW' };
  }
  if (wtx.aborted === true || ![0, 1].includes(Number(wtx.computeExitCode)) || wtx.actionSuccess !== true) {
    return { ok: false, reason: 'WALLET_TX_EXECUTION_FAILED' };
  }

  const expectedAmount = BigInt(pkg.amountNano);
  const outMsgs = Array.isArray(wtx.outMsgs) ? wtx.outMsgs : [];
  let matchedOut = null;
  for (const m of outMsgs) {
    if (!m || !sameAddress(m.destination, pkg.targetContractRaw)) continue;
    if (!String(m.msgHash || '').trim()) continue;
    let val;
    try { val = BigInt(String(m.valueNano ?? '-1')); } catch { continue; }
    // 严格精确金额，禁止 >= 放宽
    if (val !== expectedAmount) continue;
    let outCellHash = null;
    try {
      outCellHash = typeof m.bodyBoc === 'string' && m.bodyBoc.trim()
        ? await canonicalBocCellHashHex(m.bodyBoc)
        : (typeof m.bodyCellHash === 'string' ? m.bodyCellHash.toLowerCase() : null);
    } catch {
      continue;
    }
    if (outCellHash === pkg.payloadCellHash) {
      matchedOut = m;
      break;
    }
  }
  if (!matchedOut) {
    return { ok: false, reason: 'WALLET_OUT_MSG_MISMATCH' };
  }

  const ttx = evidence.targetTx;
  if (!ttx || typeof ttx !== 'object' || !String(ttx.hash || '').trim() || !String(ttx.lt || '').trim()) {
    return { ok: false, reason: 'MISSING_TARGET_TX' };
  }
  if (!sameAddress(ttx.account, pkg.targetContractRaw)) {
    return { ok: false, reason: 'TARGET_TX_ACCOUNT_MISMATCH' };
  }
  if (!sameAddress(ttx.inMsgSource, pkg.signerRaw)) {
    return { ok: false, reason: 'TARGET_IN_MSG_SOURCE_MISMATCH' };
  }
  // 必须用消息哈希强关联证明钱包出站与目标入站为同一消息，且目标交易 lt >= 钱包交易 lt
  if (String(ttx.inMsgHash || '').trim() !== String(matchedOut.msgHash).trim()) {
    return { ok: false, reason: 'MSG_HASH_LINK_MISMATCH' };
  }
  if (BigInt(String(ttx.lt)) < BigInt(String(wtx.lt))) {
    return { ok: false, reason: 'TARGET_TX_LT_BEFORE_WALLET_TX' };
  }
  let inVal;
  try { inVal = BigInt(String(ttx.inMsgValueNano ?? '-1')); } catch { inVal = -1n; }
  if (inVal !== expectedAmount) {
    return { ok: false, reason: 'TARGET_IN_MSG_AMOUNT_MISMATCH' };
  }
  if (ttx.aborted === true || ttx.bounced === true || ![0, 1].includes(Number(ttx.computeExitCode)) || ttx.actionSuccess !== true) {
    return { ok: false, reason: 'TARGET_TX_EXECUTION_FAILED' };
  }

  let inCellHash = null;
  try {
    inCellHash = typeof ttx.inMsgBodyBoc === 'string' && ttx.inMsgBodyBoc.trim()
      ? await canonicalBocCellHashHex(ttx.inMsgBodyBoc)
      : (typeof ttx.inMsgBodyCellHash === 'string' ? ttx.inMsgBodyCellHash.toLowerCase() : null);
  } catch {
    return { ok: false, reason: 'TARGET_IN_MSG_BOC_INVALID' };
  }
  if (inCellHash !== pkg.payloadCellHash) {
    return { ok: false, reason: 'TARGET_IN_MSG_PAYLOAD_MISMATCH' };
  }

  return {
    ok: true,
    walletTxHash: String(wtx.hash).trim(),
    targetTxHash: String(ttx.hash).trim(),
    msgHash: String(matchedOut.msgHash).trim(),
    seqnoAfter: evidence.walletSeqnoAfter,
    blockSeqno: evidence.blockSeqno ?? ttx.mcBlockSeqno ?? wtx.mcBlockSeqno ?? null,
  };
}

/**
 * 尝试从 W5 (v5r1) 外部入站消息体解析 signedValidUntil 与 signedSeqno：
 * W5 signed_request 布局：op(32)=0x7369676e, wallet_id(32), valid_until(32), seqno(32), ...
 */
function parseW5ExternalRequestHeader(inMsgBodyBoc) {
  if (typeof inMsgBodyBoc !== 'string' || !inMsgBodyBoc.trim()) return null;
  try {
    const roots = parseBoc(inMsgBodyBoc.trim());
    if (!roots || roots.length !== 1 || roots[0].bits < 128) return null;
    const cell = roots[0];
    const op = Number(cell.readBits(0, 32));
    if (op !== 0x7369676e) return null;
    const signedValidUntil = Number(cell.readBits(64, 32));
    const signedSeqno = Number(cell.readBits(96, 32));
    return { signedValidUntil, signedSeqno };
  } catch {
    return null;
  }
}

/**
 * 真实 TonCenter v3 W5 交易独立链确认适配器：
 * 强制匹配 signedSeqno、signedValidUntil、规范化 BoC 根 Cell 哈希、精确金额与 msgHash 关联。
 */
export function createTonCenterW5ChainVerifier({ fetchJson, network = 'mainnet', limit = 20 } = {}) {
  if (typeof fetchJson !== 'function') {
    throw new ExternalW5Error('VERIFIER_REQUIRED', 'fetchJson implementation is required');
  }
  const chainId = network === 'mainnet' ? '-239' : '-3';
  const lim = Math.max(5, Math.min(100, Math.floor(Number(limit) || 20)));

  function parseTxExec(tx) {
    const d = tx?.description || {};
    const aborted = d.aborted === true;
    const computeExitCode = d.compute_ph?.exit_code ?? (d.compute_ph?.skipped ? 0 : -1);
    const actionSuccess = d.action ? d.action.success === true : false;
    const bounced = Boolean(d.bounce && d.bounce.type === 'ok');
    return { aborted, computeExitCode: Number(computeExitCode), actionSuccess, bounced };
  }

  return async function verifyViaTonCenterV3(pkg) {
    const seqRes = await fetchJson('/runGetMethod', {
      method: 'POST',
      body: JSON.stringify({ address: pkg.signerAddress, method: 'seqno', stack: [] }),
    });
    if (!seqRes || Number(seqRes.exit_code) !== 0 || !Array.isArray(seqRes.stack) || seqRes.stack.length < 1) {
      return { reason: 'SEQNO_GETTER_UNAVAILABLE' };
    }
    const walletSeqnoAfter = Number(BigInt(String(seqRes.stack[0]?.value)));

    const wRes = await fetchJson(`/transactions?account=${encodeURIComponent(pkg.signerAddress)}&limit=${lim}&sort=desc`);
    const wTxs = Array.isArray(wRes?.transactions) ? wRes.transactions : [];
    let matchedWalletTx = null;
    let matchedMsgHash = null;

    for (const tx of wTxs) {
      const exec = parseTxExec(tx);
      const parsedHdr = parseW5ExternalRequestHeader(tx.in_msg?.message_content?.body || '');
      const signedSeqno = parsedHdr?.signedSeqno ?? null;
      const signedValidUntil = parsedHdr?.signedValidUntil ?? null;
      const outMsgs = (Array.isArray(tx.out_msgs) ? tx.out_msgs : []).map((m) => ({
        msgHash: String(m.hash || '').trim(),
        destination: m.destination,
        valueNano: String(m.value ?? '0'),
        bodyBoc: m.message_content?.body || '',
      }));

      let foundMsg = null;
      for (const m of outMsgs) {
        if (!sameAddress(m.destination, pkg.targetContractRaw)) continue;
        if (!m.msgHash || BigInt(m.valueNano) !== BigInt(pkg.amountNano)) continue;
        try {
          if ((await canonicalBocCellHashHex(m.bodyBoc)) === pkg.payloadCellHash) {
            foundMsg = m;
            break;
          }
        } catch {
          continue;
        }
      }

      if (
        foundMsg
        && signedSeqno === pkg.seqno
        && signedValidUntil === pkg.validUntil
        && Number(tx.now) >= pkg.createdAt
        && Number(tx.now) <= pkg.validUntil
        && !exec.aborted
        && [0, 1].includes(exec.computeExitCode)
        && exec.actionSuccess
      ) {
        matchedWalletTx = {
          hash: tx.hash,
          lt: String(tx.lt),
          now: Number(tx.now),
          account: tx.account,
          mcBlockSeqno: tx.mc_block_seqno ?? null,
          signedSeqno,
          signedValidUntil,
          ...exec,
          outMsgs,
        };
        matchedMsgHash = foundMsg.msgHash;
        break;
      }
    }
    if (!matchedWalletTx || !matchedMsgHash) {
      return { chainId, walletSeqnoAfter, reason: 'WALLET_TX_NOT_FOUND' };
    }

    const tRes = await fetchJson(`/transactions?account=${encodeURIComponent(pkg.targetContract)}&limit=${lim}&sort=desc`);
    const tTxs = Array.isArray(tRes?.transactions) ? tRes.transactions : [];
    let matchedTargetTx = null;
    for (const tx of tTxs) {
      const exec = parseTxExec(tx);
      const inHash = String(tx.in_msg?.hash || '').trim();
      const inBody = tx.in_msg?.message_content?.body || '';
      if (inHash !== matchedMsgHash) continue;
      let bodyCellHash = null;
      try { bodyCellHash = await canonicalBocCellHashHex(inBody); } catch { continue; }
      if (
        bodyCellHash === pkg.payloadCellHash
        && sameAddress(tx.in_msg?.source, pkg.signerRaw)
        && BigInt(String(tx.in_msg?.value ?? '-1')) === BigInt(pkg.amountNano)
        && !exec.aborted
        && !exec.bounced
        && [0, 1].includes(exec.computeExitCode)
        && exec.actionSuccess
      ) {
        matchedTargetTx = {
          hash: tx.hash,
          lt: String(tx.lt),
          account: tx.account,
          mcBlockSeqno: tx.mc_block_seqno ?? null,
          inMsgHash: inHash,
          inMsgSource: tx.in_msg?.source,
          inMsgValueNano: String(tx.in_msg?.value ?? '0'),
          inMsgBodyBoc: inBody.trim(),
          ...exec,
        };
        break;
      }
    }
    if (!matchedTargetTx) {
      return { chainId, walletSeqnoAfter, walletTx: matchedWalletTx, reason: 'TARGET_TX_NOT_FOUND' };
    }

    return {
      chainId,
      walletSeqnoAfter,
      blockSeqno: matchedTargetTx.mcBlockSeqno ?? matchedWalletTx.mcBlockSeqno ?? null,
      walletTx: matchedWalletTx,
      targetTx: matchedTargetTx,
    };
  };
}

/**
 * 阶段 4：独立链回读确认。
 */
export async function confirmPackageOnChain(pkg, chainVerifier, nowSec = Math.floor(Date.now() / 1000)) {
  if (!pkg || pkg.version !== EXTERNAL_W5_PACKAGE_VERSION) {
    throw new ExternalW5Error('INVALID_PACKAGE', 'invalid W5 signing package');
  }
  assertPackageIntegrity(pkg);
  if (pkg.state === W5_STATES.CONFIRMED) {
    throw new ExternalW5Error('ALREADY_CONFIRMED', `package ${pkg.packageId} is already CONFIRMED`);
  }
  if (pkg.state !== W5_STATES.SIGNED_SUBMITTED && pkg.state !== W5_STATES.PENDING_CHAIN_VERIFICATION) {
    throw new ExternalW5Error('INVALID_STATE_TRANSITION', `cannot confirm package from state ${pkg.state}`);
  }
  if (typeof chainVerifier !== 'function') {
    throw new ExternalW5Error('VERIFIER_REQUIRED', 'independent chainVerifier function is required');
  }

  const nextVersion = Number(pkg.stateVersion || 1) + 1;
  let evidence;
  try {
    evidence = await chainVerifier(pkg);
  } catch (e) {
    return {
      ...pkg,
      state: W5_STATES.PENDING_CHAIN_VERIFICATION,
      stateVersion: nextVersion,
      updatedAt: Number(nowSec),
      history: [
        ...pkg.history,
        { at: Number(nowSec), state: W5_STATES.PENDING_CHAIN_VERIFICATION, note: `chain verifier error: ${e?.message || e}` },
      ],
    };
  }

  const verified = await verifyOnChainW5Evidence(pkg, evidence);
  if (verified.ok) {
    return {
      ...pkg,
      state: W5_STATES.CONFIRMED,
      stateVersion: nextVersion,
      updatedAt: Number(nowSec),
      confirmation: {
        txHash: verified.walletTxHash,
        walletTxHash: verified.walletTxHash,
        targetTxHash: verified.targetTxHash,
        msgHash: verified.msgHash,
        seqnoAfter: verified.seqnoAfter,
        blockSeqno: verified.blockSeqno,
        confirmedAt: Number(nowSec),
      },
      history: [
        ...pkg.history,
        {
          at: Number(nowSec),
          state: W5_STATES.CONFIRMED,
          note: `independent chain verified walletTx=${verified.walletTxHash} targetTx=${verified.targetTxHash} msgHash=${verified.msgHash}`,
        },
      ],
    };
  }

  return {
    ...pkg,
    state: W5_STATES.PENDING_CHAIN_VERIFICATION,
    stateVersion: nextVersion,
    updatedAt: Number(nowSec),
    history: [
      ...pkg.history,
      {
        at: Number(nowSec),
        state: W5_STATES.PENDING_CHAIN_VERIFICATION,
        note: `pending chain verification: ${verified.reason || evidence?.reason || 'unverified'}`,
      },
    ],
  };
}

/**
 * 原子写入、进程互斥锁、严格状态机转换与存储层掌控版本递增的持久化存储。
 */
export class ExternalW5SessionStore {
  constructor(filePath, { staleLockMs = 30_000 } = {}) {
    if (!filePath) throw new ExternalW5Error('INVALID_STORE_PATH', 'session store filePath is required');
    this.filePath = filePath;
    this.lockPath = `${filePath}.lock`;
    this.staleLockMs = Math.max(1000, Number(staleLockMs) || 30_000);
  }

  _acquireLock() {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const payload = JSON.stringify({ pid: process.pid, acquiredAt: Date.now() });
    try {
      const fd = openSync(this.lockPath, 'wx', 0o600);
      try {
        writeFileSync(fd, payload, 'utf8');
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      return true;
    } catch (e) {
      if (e?.code !== 'EEXIST') throw e;
      try {
        const meta = JSON.parse(readFileSync(this.lockPath, 'utf8'));
        const age = Date.now() - Number(meta.acquiredAt || 0);
        let alive = true;
        if (Number.isInteger(meta.pid) && meta.pid > 0 && meta.pid !== process.pid) {
          try { process.kill(meta.pid, 0); } catch { alive = false; }
        }
        if (!alive && age > this.staleLockMs) {
          unlinkSync(this.lockPath);
          return this._acquireLock();
        }
      } catch {
        // 无法解析锁文件时保守按忙碌拒绝
      }
      throw new ExternalW5Error('STORE_LOCK_BUSY', `session store lock is held by another process: ${this.lockPath}`);
    }
  }

  _releaseLock() {
    try {
      unlinkSync(this.lockPath);
    } catch (e) {
      if (e?.code !== 'ENOENT') throw e;
    }
  }

  _readAllUnlocked() {
    if (!existsSync(this.filePath)) return {};
    const raw = readFileSync(this.filePath, 'utf8');
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      throw new ExternalW5Error('CORRUPT_STORE', `corrupt session store JSON at ${this.filePath}: ${e?.message || e}`);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new ExternalW5Error('CORRUPT_STORE', 'session store root must be a JSON object');
    }
    return parsed;
  }

  _atomicWriteAllUnlocked(data) {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tmpPath = `${this.filePath}.tmp.${process.pid}.${randomBytes(6).toString('hex')}`;
    const content = `${JSON.stringify(data, null, 2)}\n`;
    const fd = openSync(tmpPath, 'wx', 0o600);
    try {
      writeFileSync(fd, content, 'utf8');
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmpPath, this.filePath);
  }

  _validateAndCommitUnlocked(all, existing, nextPkg, expectedStateVersion) {
    if (!nextPkg || !nextPkg.packageId) {
      throw new ExternalW5Error('INVALID_PACKAGE', 'pkg.packageId is required');
    }
    if (!existing) {
      if (expectedStateVersion !== null && expectedStateVersion !== 0) {
        throw new ExternalW5Error('STATE_VERSION_CONFLICT', `expected stateVersion=${expectedStateVersion}, actual=0`);
      }
      if (nextPkg.state !== W5_STATES.PREPARED) {
        throw new ExternalW5Error('INVALID_STATE_TRANSITION', `new session must start in PREPARED, got ${nextPkg.state}`);
      }
      // 首次写入由存储层强制控制初始版本号为 1
      const committed = { ...nextPkg, stateVersion: 1 };
      all[committed.packageId] = committed;
      this._atomicWriteAllUnlocked(all);
      return committed;
    }

    if (existing.packageHash !== nextPkg.packageHash) {
      throw new ExternalW5Error('PACKAGE_TAMPERED', 'cannot overwrite session with different packageHash');
    }

    const actualVer = Number(existing.stateVersion || 0);
    if (expectedStateVersion !== null) {
      if (actualVer !== expectedStateVersion) {
        throw new ExternalW5Error(
          'STATE_VERSION_CONFLICT',
          `expected stateVersion=${expectedStateVersion} for ${nextPkg.packageId}, actual=${actualVer}`,
        );
      }
    } else {
      // 未传 expectedStateVersion 时，仍严格拦截同版本不同内容与旧版本覆盖
      const incomingVer = Number(nextPkg.stateVersion || 0);
      if (incomingVer < actualVer) {
        throw new ExternalW5Error(
          'STATE_VERSION_CONFLICT',
          `refusing to overwrite ${nextPkg.packageId} stateVersion ${actualVer} with older ${incomingVer}`,
        );
      }
      if (incomingVer === actualVer) {
        if (canonicalStringify(existing) === canonicalStringify(nextPkg)) {
          return existing;
        }
        throw new ExternalW5Error(
          'STATE_VERSION_CONFLICT',
          `refusing different content at identical stateVersion=${actualVer} for ${nextPkg.packageId}`,
        );
      }
    }

    // 强制状态转换规则：CONFIRMED / REJECTED 终态永不回退或修改
    const allowedNext = ALLOWED_W5_TRANSITIONS[existing.state] || [];
    if (!allowedNext.includes(nextPkg.state)) {
      throw new ExternalW5Error(
        'INVALID_STATE_TRANSITION',
        `illegal W5 state transition: ${existing.state} -> ${nextPkg.state}`,
      );
    }

    // 版本递增严格由存储层控制（严格 +1，不信任调用方自填的任意大版本号）
    const committed = {
      ...nextPkg,
      stateVersion: actualVer + 1,
    };
    all[committed.packageId] = committed;
    this._atomicWriteAllUnlocked(all);
    return committed;
  }

  save(pkg, { expectedStateVersion = null } = {}) {
    this._acquireLock();
    try {
      const all = this._readAllUnlocked();
      const existing = all[pkg?.packageId] || null;
      return this._validateAndCommitUnlocked(all, existing, pkg, expectedStateVersion);
    } finally {
      this._releaseLock();
    }
  }

  async update(packageId, expectedStateVersion, mutatorFn) {
    if (typeof mutatorFn !== 'function') throw new ExternalW5Error('INVALID_MUTATOR', 'mutatorFn is required');
    this._acquireLock();
    try {
      const all = this._readAllUnlocked();
      const existing = all[packageId] || null;
      const actualVer = existing ? Number(existing.stateVersion || 0) : 0;
      if (actualVer !== expectedStateVersion) {
        throw new ExternalW5Error(
          'STATE_VERSION_CONFLICT',
          `expected stateVersion=${expectedStateVersion} for ${packageId}, actual=${actualVer}`,
        );
      }
      const next = await mutatorFn(existing);
      if (!next || next.packageId !== packageId) {
        throw new ExternalW5Error('INVALID_PACKAGE', 'mutator must return package with matching packageId');
      }
      return this._validateAndCommitUnlocked(all, existing, next, expectedStateVersion);
    } finally {
      this._releaseLock();
    }
  }

  load(packageId) {
    const all = this._readAllUnlocked();
    return all[packageId] || null;
  }

  list() {
    return Object.values(this._readAllUnlocked());
  }
}

/**
 * 从锁定主网部署包（只读）提取公开角色确认表，保留 keeper/roundOpener 合设待业主签认。
 */
export function buildMainnetRoleConfirmationTable(bundlePath = LOCKED_BUNDLE_PATH) {
  const bytes = readFileSync(bundlePath);
  const actualSha = createHash('sha256').update(bytes).digest('hex');
  if (actualSha !== LOCKED_BUNDLE_SHA256) {
    throw new ExternalW5Error(
      'LOCKED_BUNDLE_TAMPERED',
      `bundle-mainnet-v17.0.json sha256 mismatch: expected ${LOCKED_BUNDLE_SHA256}, got ${actualSha}`,
    );
  }
  const bundle = JSON.parse(String(bytes));
  const roles = SIGNER_ROLES.map((role) => ({
    role,
    publicAddress: bundle.roles[role],
    expectedWalletVersion: 'v5r1',
    expectedChainId: bundle.chainId,
    signingMode: 'external_w5',
  }));
  const uniqueAddresses = Array.from(new Set(roles.map((r) => r.publicAddress)));
  const keeperRoundOpenerShared = sameAddress(bundle.roles.keeper, bundle.roles.roundOpener);

  return {
    status: 'DRAFT_PENDING_OWNER_SIGNOFF',
    ownerSignedOff: false,
    bundleSha256: actualSha,
    network: bundle.network,
    chainId: bundle.chainId,
    protocolVersion: bundle.protocolVersion,
    roleCount: roles.length,
    uniqueAddressCount: uniqueAddresses.length,
    keeperRoundOpenerShared,
    pendingOwnerDecisions: keeperRoundOpenerShared
      ? [
          `keeper 与 roundOpener 当前在锁定部署包中共用地址 ${bundle.roles.keeper}，保留现状待业主书面签认，本模块不自行调整角色。`,
        ]
      : [],
    roles,
  };
}
