// A9 协议 v17 — 返佣与空投链上终局核验与原子批次记账服务。
// 安全红线：
// 1. 绝不直接信任客户端、管理员或未验真的快照对象；入口处强制重算 airdropSeedHash、evidenceHash 与全量守恒。
// 2. 强制要求同库预算账本（budgetLedger.db === db），严禁缺失预算或跨库预算跳过扣减。
// 3. 对照 RoundController.tolk 与 StakeTicket.tolk 真实接口：
//    - 直接 getter：get_round(roundId)、get_ticket_address(owner, roundId)、StakeTicket.get_ticket_data()
//    - 链上事件重建：EvDepositAccepted (0x52540103)、EvEarlyExited (0x52540109)、EvRoundSettled (0x52540102)
//    - 正确支持锁仓期内提前解押后重新锁仓（TicketAddStake 复位 exited=false），以 get_ticket_data() 最终状态结合全局 sum === totalStakeRaw 守恒为准。
// 4. 不移除 api.mjs 主网 V17_CHAIN_SETTLEMENT_UNAVAILABLE 503 保护门禁。
import { addressKey, addressAliases, normalizeTonAddress } from './ton-address.mjs';
import { parseBoc } from './ton-cell.mjs';
import { BudgetError } from './promo-budget.mjs';
import {
  V17RewardError,
  DEFAULT_AIRDROP_PRIZE_RAW,
  buildStakeReferralCreditId,
  computeStakeReferralCommissionRaw,
  pickDeterministicAirdropWinner,
} from './v17-rewards.mjs';

export const V17_FINALITY_SNAPSHOT_VERSION = 'a9-v17-chain-finality-v1';

// 模块私有可信来源登记表：仅允许由本模块 buildVerifiedRoundFinalitySnapshot 经服务端链读取生成的不可变快照通过，
// 彻底区分「哈希自洽」与「可信链来源」，阻止任何外部伪造数据并重算全部哈希的快照注入。
const TRUSTED_CHAIN_SNAPSHOTS = new WeakSet();

function deepFreeze(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  Object.freeze(obj);
  for (const val of Object.values(obj)) {
    if (val && typeof val === 'object' && !Object.isFrozen(val)) {
      deepFreeze(val);
    }
  }
  return obj;
}

function assertTrustedChainSnapshotOrigin(snapshot, { expectedNetwork, expectedRoundController } = {}) {
  if (!snapshot || typeof snapshot !== 'object' || !TRUSTED_CHAIN_SNAPSHOTS.has(snapshot)) {
    throw new V17RewardError(
      'UNTRUSTED_SNAPSHOT_ORIGIN',
      'snapshot must originate from trusted server-side chain verification; externally constructed snapshots are rejected even if self-consistent',
    );
  }
  const expNet = String(expectedNetwork || '').trim().toLowerCase();
  if (expNet !== 'mainnet' && expNet !== 'testnet') {
    throw new V17RewardError('EXPECTED_CHAIN_REQUIRED', 'expectedNetwork (mainnet|testnet) is required');
  }
  const expRc = String(expectedRoundController || '').trim();
  if (!normalizeTonAddress(expRc)) {
    throw new V17RewardError('EXPECTED_CHAIN_REQUIRED', 'expectedRoundController valid TON address is required');
  }
  if (snapshot.network !== expNet || addressKey(snapshot.roundController) !== addressKey(expRc)) {
    throw new V17RewardError(
      'CHAIN_ORIGIN_MISMATCH',
      `snapshot origin (${snapshot.network}/${snapshot.roundController}) does not match expected (${expNet}/${addressKey(expRc)})`,
    );
  }
}

// RoundController.tolk 真实状态码
export const RC_STATUS_ACTIVE = 1;
export const RC_STATUS_SUCCEEDED = 2;
export const RC_STATUS_FAILED = 3;
export const RC_STATUS_ABORTED = 4;

// RoundController.tolk 真实事件操作码
export const EV_ROUND_SETTLED_OP = 0x52540102;
export const EV_DEPOSIT_ACCEPTED_OP = 0x52540103;
export const EV_EARLY_EXITED_OP = 0x52540109;

const changes = (r) => Number(r?.meta?.changes ?? r?.changes ?? 0);

function canonicalStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((x) => canonicalStringify(x)).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalStringify(value[k])}`).join(',')}}`;
}

async function sha256HexAsync(input) {
  const str = typeof input === 'string' ? input : canonicalStringify(input);
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return `0x${Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}

function normalizeHexHash(raw, label) {
  const s = String(raw || '').trim();
  if (!s) throw new V17RewardError('MISSING_CHAIN_EVIDENCE', `${label} is required`);
  if (/^0x[0-9a-fA-F]{64}$/.test(s)) return s.toLowerCase();
  if (/^[0-9a-fA-F]{64}$/.test(s)) return `0x${s.toLowerCase()}`;
  if (/^[A-Za-z0-9+/=_-]{43,44}$/.test(s)) return s;
  throw new V17RewardError('INVALID_CHAIN_EVIDENCE', `${label} is not a valid 32-byte hash: ${s}`);
}

function readStdAddressFromCell(cell, bitOffset) {
  if (cell.bits < bitOffset + 267) {
    throw new V17RewardError('INVALID_CHAIN_EVIDENCE', 'truncated address in event cell');
  }
  const tag = Number(cell.readBits(bitOffset, 2));
  const anycast = Number(cell.readBits(bitOffset + 2, 1));
  if (tag !== 2 || anycast !== 0) {
    throw new V17RewardError('INVALID_CHAIN_EVIDENCE', 'unsupported non-standard address in event cell');
  }
  let wc = Number(cell.readBits(bitOffset + 3, 8));
  if (wc > 127) wc -= 256;
  const hashHex = cell.readBits(bitOffset + 11, 256).toString(16).padStart(64, '0');
  return { address: `${wc}:${hashHex}`, nextOffset: bitOffset + 267 };
}

/**
 * 严格按 v17/contracts/types.tolk 位布局解码 RoundController 外部日志事件 BoC。
 * 未识别的操作码返回 null；已识别操作码若位宽损坏直接抛错（fail-closed）。
 */
export function decodeRoundControllerEventBoc(bodyBoc) {
  if (typeof bodyBoc !== 'string' || !bodyBoc.trim()) return null;
  let roots;
  try {
    roots = parseBoc(bodyBoc.trim());
  } catch {
    return null;
  }
  if (!Array.isArray(roots) || roots.length !== 1) return null;
  const cell = roots[0];
  if (cell.bits < 32) return null;
  const op = Number(cell.readBits(0, 32));

  if (op === EV_ROUND_SETTLED_OP) {
    // 32 + 32 + 8 + 8 + 256 + 128*5 = 976 bits <= 1023 bits
    if (cell.bits < 976) {
      throw new V17RewardError('INVALID_CHAIN_EVIDENCE', `EvRoundSettled cell truncated (${cell.bits} bits)`);
    }
    let pos = 32;
    const roundId = Number(cell.readBits(pos, 32)); pos += 32;
    const status = Number(cell.readBits(pos, 8)); pos += 8;
    const qualifiedCandles = Number(cell.readBits(pos, 8)); pos += 8;
    const candleHash = `0x${cell.readBits(pos, 256).toString(16).padStart(64, '0')}`; pos += 256;
    const totalStakeRaw = cell.readBits(pos, 128).toString(); pos += 128;
    const rewardBudgetRaw = cell.readBits(pos, 128).toString(); pos += 128;
    const teamReleasedRaw = cell.readBits(pos, 128).toString(); pos += 128;
    const burnedRaw = cell.readBits(pos, 128).toString(); pos += 128;
    const carryAfterRaw = cell.readBits(pos, 128).toString();
    return {
      op,
      type: 'EvRoundSettled',
      roundId,
      status,
      qualifiedCandles,
      candleHash,
      totalStakeRaw,
      rewardBudgetRaw,
      teamReleasedRaw,
      burnedRaw,
      carryAfterRaw,
    };
  }

  if (op === EV_DEPOSIT_ACCEPTED_OP) {
    // 32 + 32 + 267 + 128 + 1 = 460 bits
    if (cell.bits < 460) {
      throw new V17RewardError('INVALID_CHAIN_EVIDENCE', `EvDepositAccepted cell truncated (${cell.bits} bits)`);
    }
    const roundId = Number(cell.readBits(32, 32));
    const { address: owner, nextOffset } = readStdAddressFromCell(cell, 64);
    const amountRaw = cell.readBits(nextOffset, 128).toString();
    const isEarly = cell.readBits(nextOffset + 128, 1) !== 0n;
    return { op, type: 'EvDepositAccepted', roundId, owner, amountRaw, isEarly };
  }

  if (op === EV_EARLY_EXITED_OP) {
    // 32 + 267 + 32 + 128 + 128 = 587 bits
    if (cell.bits < 587) {
      throw new V17RewardError('INVALID_CHAIN_EVIDENCE', `EvEarlyExited cell truncated (${cell.bits} bits)`);
    }
    const { address: owner, nextOffset } = readStdAddressFromCell(cell, 32);
    const roundId = Number(cell.readBits(nextOffset, 32));
    const refundRaw = cell.readBits(nextOffset + 32, 128).toString();
    const burnedRaw = cell.readBits(nextOffset + 160, 128).toString();
    return { op, type: 'EvEarlyExited', roundId, owner, refundRaw, burnedRaw };
  }

  return null;
}

/**
 * 真实 TonCenter 链读取与多页事件分页适配器：
 * - getRound: 复用 TonCenterClient.fetchRound (get_round)
 * - getTicketData: 复用 TonCenterClient.fetchUserTicket (get_ticket_address + StakeTicket.get_ticket_data)
 * - getRoundEvents: 通过 TonCenter v3 /transactions 分页扫描 RoundController 历史交易外部日志，
 *   严格检测页结构、重复页与页数上限截断；仅在完整覆盖至 stakeOpenAt 之前或合约历史起点时返回 complete=true。
 */
export function createTonCenterV17ChainReader({
  tonCenter,
  pageLimit = 100,
  maxPages = 50,
} = {}) {
  if (!tonCenter || typeof tonCenter.fetchRound !== 'function' || typeof tonCenter.fetchUserTicket !== 'function' || typeof tonCenter._requestV3 !== 'function') {
    throw new V17RewardError('CHAIN_READER_UNAVAILABLE', 'valid TonCenterClient instance is required');
  }
  const lim = Math.max(1, Math.min(200, Math.floor(Number(pageLimit) || 100)));
  const maxP = Math.max(1, Math.floor(Number(maxPages) || 50));

  return {
    async getRound(rcAddr, roundId) {
      return tonCenter.fetchRound(rcAddr, roundId);
    },

    async getTicketData(rcAddr, owner, roundId) {
      const td = await tonCenter.fetchUserTicket(rcAddr, owner, roundId);
      if (!td) return null;
      return {
        ...td,
        owner: td.owner || owner,
      };
    },

    async getRoundEvents(rcAddr, roundId, { stakeOpenAt, settledAt }) {
      const rId = Number(roundId);
      const depositEvents = [];
      const earlyExitEvents = [];
      let settlementEvent = null;
      let complete = false;

      let endLt = null;
      const seenTxIds = new Set();

      for (let page = 0; page < maxP; page += 1) {
        const qs = new URLSearchParams({
          account: rcAddr,
          limit: String(lim),
          sort: 'desc',
        });
        if (endLt !== null) qs.set('end_lt', String(endLt));

        const res = await tonCenter._requestV3(`/transactions?${qs.toString()}`);
        if (!res || !Array.isArray(res.transactions)) {
          return { complete: false, reason: 'MALFORMED_V3_TRANSACTIONS', settlementEvent: null, depositEvents: [], earlyExitEvents: [] };
        }
        const txs = res.transactions;
        if (txs.length === 0) {
          complete = true;
          break;
        }

        let newInPage = 0;
        let oldestLtInPage = null;
        let reachedBeforeOpen = false;

        for (const tx of txs) {
          if (!tx || typeof tx !== 'object' || !tx.hash || !tx.lt) {
            return { complete: false, reason: 'MALFORMED_TX_ENTRY', settlementEvent: null, depositEvents: [], earlyExitEvents: [] };
          }
          const txKey = `${tx.lt}:${tx.hash}`;
          if (seenTxIds.has(txKey)) continue;
          seenTxIds.add(txKey);
          newInPage += 1;

          const ltBig = BigInt(String(tx.lt));
          if (oldestLtInPage === null || ltBig < oldestLtInPage) oldestLtInPage = ltBig;

          // 跳过失败/中止的交易（外部日志只应采信成功执行交易）
          if (tx.description?.aborted === true) continue;

          const txNow = Number(tx.now || 0);
          if (Number.isInteger(stakeOpenAt) && stakeOpenAt > 0 && txNow > 0 && txNow < stakeOpenAt) {
            reachedBeforeOpen = true;
          }

          for (const outMsg of Array.isArray(tx.out_msgs) ? tx.out_msgs : []) {
            // 外部日志消息 destination 为 null/空
            if (outMsg?.destination) continue;
            const bodyBoc = outMsg?.message_content?.body;
            if (!bodyBoc) continue;
            const decoded = decodeRoundControllerEventBoc(bodyBoc);
            if (!decoded || Number(decoded.roundId) !== rId) continue;

            if (decoded.type === 'EvRoundSettled') {
              if (!settlementEvent) {
                settlementEvent = {
                  ...decoded,
                  txHash: String(tx.hash),
                  lt: String(tx.lt),
                  mcBlockSeqno: tx.mc_block_seqno ?? null,
                };
              }
            } else if (decoded.type === 'EvDepositAccepted') {
              depositEvents.push({
                ...decoded,
                txHash: String(tx.hash),
                lt: String(tx.lt),
              });
            } else if (decoded.type === 'EvEarlyExited') {
              earlyExitEvents.push({
                ...decoded,
                txHash: String(tx.hash),
                lt: String(tx.lt),
              });
            }
          }
        }

        if (newInPage === 0) {
          // 重复页保护：绝不判 complete=true
          complete = false;
          break;
        }
        if (reachedBeforeOpen || txs.length < lim) {
          complete = true;
          break;
        }
        if (oldestLtInPage === null || oldestLtInPage <= 1n) {
          complete = true;
          break;
        }
        endLt = (oldestLtInPage - 1n).toString();
      }

      // 若 settledAt 有效且扫描未拿到结算事件，仍保持 complete 但上层会因缺失 settlementEvent 拒绝
      return {
        complete,
        settledAt: Number(settledAt || 0),
        settlementEvent,
        depositEvents,
        earlyExitEvents,
      };
    },
  };
}

/**
 * 强校验终局快照自身的数学守恒、种子派生与 evidenceHash 完整性（防伪造/篡改快照注入）。
 */
export async function verifyRoundFinalitySnapshotIntegrity(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') {
    throw new V17RewardError('INVALID_CHAIN_EVIDENCE', 'verified finality snapshot is required');
  }
  if (snapshot.version !== V17_FINALITY_SNAPSHOT_VERSION) {
    throw new V17RewardError('INVALID_CHAIN_EVIDENCE', `unsupported snapshot version: ${snapshot.version}`);
  }
  const net = String(snapshot.network || '').trim().toLowerCase();
  if (net !== 'mainnet' && net !== 'testnet') {
    throw new V17RewardError('INVALID_CHAIN_EVIDENCE', `invalid snapshot network: ${snapshot.network}`);
  }
  if (!normalizeTonAddress(String(snapshot.roundController || ''))) {
    throw new V17RewardError('INVALID_CHAIN_EVIDENCE', 'invalid snapshot roundController');
  }
  const rId = Number(snapshot.roundId);
  const statusCode = Number(snapshot.statusCode);
  const settledAt = Number(snapshot.settledAt);
  if (!Number.isInteger(rId) || rId < 1) {
    throw new V17RewardError('INVALID_CHAIN_EVIDENCE', 'invalid snapshot roundId');
  }
  if (statusCode !== RC_STATUS_SUCCEEDED && statusCode !== RC_STATUS_FAILED && statusCode !== RC_STATUS_ABORTED) {
    throw new V17RewardError('INVALID_CHAIN_EVIDENCE', `non-final snapshot statusCode: ${statusCode}`);
  }
  if (!Number.isInteger(settledAt) || settledAt <= 0) {
    throw new V17RewardError('INVALID_CHAIN_EVIDENCE', 'invalid snapshot settledAt');
  }

  const settlementTxHash = normalizeHexHash(snapshot.settlementTxHash, 'snapshot.settlementTxHash');
  const candleHash = statusCode === RC_STATUS_ABORTED
    ? '0x0'
    : normalizeHexHash(snapshot.candleHash, 'snapshot.candleHash');
  if (snapshot.candleHash !== candleHash) {
    throw new V17RewardError('SNAPSHOT_TAMPERED', 'snapshot candleHash format/value mismatch');
  }

  const totalStakeRaw = BigInt(String(snapshot.totalStakeRaw ?? '-1'));
  const rewardBudgetRaw = BigInt(String(snapshot.rewardBudgetRaw ?? '-1'));
  if (totalStakeRaw < 0n || rewardBudgetRaw < 0n) {
    throw new V17RewardError('SNAPSHOT_TAMPERED', 'negative totalStakeRaw or rewardBudgetRaw');
  }
  if (!Array.isArray(snapshot.participants) || snapshot.participants.length !== Number(snapshot.participantCount)) {
    throw new V17RewardError('SNAPSHOT_TAMPERED', 'participantCount does not match participants length');
  }

  let sumStake = 0n;
  const seenKeys = new Set();
  for (let i = 0; i < snapshot.participants.length; i += 1) {
    const p = snapshot.participants[i];
    if (!p || typeof p !== 'object' || !normalizeTonAddress(String(p.walletAddress || ''))) {
      throw new V17RewardError('SNAPSHOT_TAMPERED', `invalid participant[${i}] walletAddress`);
    }
    const key = addressKey(p.walletAddress);
    if (p.walletKey !== key || seenKeys.has(key)) {
      throw new V17RewardError('SNAPSHOT_TAMPERED', `duplicate or mismatched participant[${i}] walletKey`);
    }
    if (i > 0 && snapshot.participants[i - 1].walletKey >= key) {
      throw new V17RewardError('SNAPSHOT_TAMPERED', 'participants must be strictly sorted by walletKey');
    }
    seenKeys.add(key);

    const stake = BigInt(String(p.stakeRaw ?? '0'));
    if (stake <= 0n) {
      throw new V17RewardError('SNAPSHOT_TAMPERED', `participant[${i}] stakeRaw must be > 0`);
    }
    sumStake += stake;

    const expectedReward = statusCode === RC_STATUS_SUCCEEDED && totalStakeRaw > 0n
      ? (rewardBudgetRaw * stake) / totalStakeRaw
      : 0n;
    if (BigInt(String(p.computedRewardRaw ?? '-1')) !== expectedReward) {
      throw new V17RewardError('SNAPSHOT_TAMPERED', `participant[${i}] computedRewardRaw does not match on-chain formula`);
    }
  }

  if (sumStake !== totalStakeRaw) {
    throw new V17RewardError('SNAPSHOT_TAMPERED', `participant stake sum (${sumStake}) != totalStakeRaw (${totalStakeRaw})`);
  }

  const rcKey = addressKey(snapshot.roundController);
  const expectedSeed = await sha256HexAsync(
    `a9-v17-airdrop-seed:${net}:${rcKey}:${rId}:${settlementTxHash}:${candleHash}`,
  );
  if (snapshot.airdropSeedHash !== expectedSeed) {
    throw new V17RewardError('SNAPSHOT_TAMPERED', 'snapshot airdropSeedHash mismatch');
  }

  const core = {
    version: snapshot.version,
    network: net,
    roundController: rcKey,
    roundId: rId,
    statusCode,
    settledAt,
    settlementTxHash,
    candleHash,
    totalStakeRaw: totalStakeRaw.toString(),
    rewardBudgetRaw: rewardBudgetRaw.toString(),
    participantCount: snapshot.participants.length,
    participants: snapshot.participants,
    airdropSeedHash: expectedSeed,
  };
  const expectedEvidenceHash = await sha256HexAsync(core);
  if (snapshot.evidenceHash !== expectedEvidenceHash) {
    throw new V17RewardError('SNAPSHOT_TAMPERED', 'snapshot evidenceHash mismatch');
  }
  return true;
}

/**
 * 强制校验预算账本存在且与当前记账数据库为同一个 D1 实例，防止跳过预算或跨库非原子写入。
 */
function assertSameDbBudgetLedger(db, budgetLedger) {
  if (!budgetLedger || typeof budgetLedger.prepareAtomicReserve !== 'function') {
    throw new V17RewardError('BUDGET_LEDGER_REQUIRED', 'D1 budgetLedger with prepareAtomicReserve is mandatory');
  }
  if (budgetLedger.db !== db) {
    throw new V17RewardError('CROSS_DB_BUDGET_FORBIDDEN', 'budgetLedger must share the exact same D1 database instance');
  }
}

/**
 * 从链上只读客户端重建并交叉核验单轮不可变终局快照。
 */
export async function buildVerifiedRoundFinalitySnapshot({
  network,
  roundController,
  roundId,
  chainReader,
}) {
  const net = String(network || '').trim().toLowerCase();
  if (net !== 'mainnet' && net !== 'testnet') {
    throw new V17RewardError('INVALID_NETWORK', `unsupported network: ${network}`);
  }
  const rcAddr = String(roundController || '').trim();
  if (!normalizeTonAddress(rcAddr)) {
    throw new V17RewardError('INVALID_CONTRACT', 'roundController must be a valid TON address');
  }
  const rcKey = addressKey(rcAddr);
  const rId = Number(roundId);
  if (!Number.isInteger(rId) || rId < 1) {
    throw new V17RewardError('BAD_ROUND_ID', 'roundId must be a positive integer');
  }
  const readTicketFn = chainReader?.getTicketData || chainReader?.getTicketState;
  if (!chainReader || typeof chainReader.getRound !== 'function' || typeof chainReader.getRoundEvents !== 'function' || typeof readTicketFn !== 'function') {
    throw new V17RewardError('CHAIN_READER_UNAVAILABLE', 'complete chainReader (getRound, getRoundEvents, getTicketData) is required');
  }

  // 1) 直接读取 RoundController.get_round(roundId)
  const round = await chainReader.getRound(rcAddr, rId);
  if (!round || typeof round !== 'object') {
    throw new V17RewardError('MISSING_CHAIN_EVIDENCE', `get_round(${rId}) returned empty`);
  }
  const statusCode = Number(round.status);
  if (statusCode !== RC_STATUS_SUCCEEDED && statusCode !== RC_STATUS_FAILED && statusCode !== RC_STATUS_ABORTED) {
    throw new V17RewardError('ROUND_NOT_FINAL', `round #${rId} is not in final status (status=${statusCode})`);
  }
  const stakeOpenAt = Number(round.stakeOpenAt || 0);
  const settledAt = Number(round.settledAt || 0);
  if (!Number.isInteger(settledAt) || settledAt <= 0) {
    throw new V17RewardError('MISSING_CHAIN_EVIDENCE', `round #${rId} missing valid settledAt`);
  }
  const totalStakeRaw = BigInt(String(round.totalStakeRaw ?? '0'));
  const rewardBudgetRaw = BigInt(String(round.rewardBudgetRaw ?? '0'));
  const candleHash = statusCode === RC_STATUS_ABORTED
    ? '0x0'
    : normalizeHexHash(round.candleHash, 'round.candleHash');

  // 2) 从链上事件历史重建候选参与者与结算交易证据（必须完整分页，不允许截断）
  const history = await chainReader.getRoundEvents(rcAddr, rId, { stakeOpenAt, settledAt });
  if (!history || history.complete !== true) {
    throw new V17RewardError('INCOMPLETE_CHAIN_HISTORY', `chain event history for round #${rId} is incomplete; refusing fail-closed`);
  }
  const settleEv = history.settlementEvent;
  if (!settleEv || typeof settleEv !== 'object') {
    throw new V17RewardError('MISSING_CHAIN_EVIDENCE', `EvRoundSettled missing for round #${rId}`);
  }
  if (Number(settleEv.roundId) !== rId || Number(settleEv.status) !== statusCode) {
    throw new V17RewardError('CHAIN_EVIDENCE_MISMATCH', 'EvRoundSettled roundId/status does not match get_round');
  }
  if (BigInt(String(settleEv.totalStakeRaw ?? '-1')) !== totalStakeRaw) {
    throw new V17RewardError('CHAIN_EVIDENCE_MISMATCH', 'EvRoundSettled totalStakeRaw does not match get_round');
  }
  if (BigInt(String(settleEv.rewardBudgetRaw ?? '-1')) !== rewardBudgetRaw) {
    throw new V17RewardError('CHAIN_EVIDENCE_MISMATCH', 'EvRoundSettled rewardBudgetRaw does not match get_round');
  }
  const settlementTxHash = normalizeHexHash(settleEv.txHash, 'settlementEvent.txHash');
  if (statusCode !== RC_STATUS_ABORTED) {
    const evCandleHash = normalizeHexHash(settleEv.candleHash, 'settlementEvent.candleHash');
    if (evCandleHash !== candleHash) {
      throw new V17RewardError('CHAIN_EVIDENCE_MISMATCH', 'EvRoundSettled candleHash does not match get_round');
    }
  }

  // 3) 汇总候选入金地址并逐个向 StakeTicket.get_ticket_data() 核验最终真实持仓
  // 注意：StakeTicket.tolk 允许锁仓期内提前解押后重新锁仓（TicketAddStake 复位 exited=false），
  // 因此以 get_ticket_data() 的最终状态（!exited && amountRaw > 0）为准，并以全局守恒 sum === totalStakeRaw 兜底。
  const candidateMap = new Map();
  for (const ev of Array.isArray(history.depositEvents) ? history.depositEvents : []) {
    if (Number(ev?.roundId) !== rId) continue;
    const owner = String(ev?.owner || '').trim();
    if (!normalizeTonAddress(owner)) {
      throw new V17RewardError('INVALID_CHAIN_EVIDENCE', `invalid owner address in EvDepositAccepted: ${owner}`);
    }
    const key = addressKey(owner);
    if (!candidateMap.has(key)) candidateMap.set(key, owner);
  }

  const participants = [];
  let sumStake = 0n;
  const sortedCandidateKeys = Array.from(candidateMap.keys()).sort();

  for (const key of sortedCandidateKeys) {
    const owner = candidateMap.get(key);
    const ticket = await readTicketFn.call(chainReader, rcAddr, owner, rId);
    if (!ticket || typeof ticket !== 'object') {
      throw new V17RewardError('MISSING_CHAIN_EVIDENCE', `StakeTicket get_ticket_data() unavailable for ${owner} in round #${rId}`);
    }
    if (Number(ticket.roundId) !== rId || (ticket.owner && addressKey(String(ticket.owner)) !== key)) {
      throw new V17RewardError('CHAIN_EVIDENCE_MISMATCH', `StakeTicket owner/roundId mismatch for ${owner}`);
    }
    const amountRaw = BigInt(String(ticket.amountRaw ?? '0'));
    const exited = Boolean(ticket.exited);
    if (exited || amountRaw <= 0n) {
      continue;
    }
    sumStake += amountRaw;
    const computedRewardRaw = statusCode === RC_STATUS_SUCCEEDED && totalStakeRaw > 0n
      ? (rewardBudgetRaw * amountRaw) / totalStakeRaw
      : 0n;
    participants.push({
      walletKey: key,
      walletAddress: owner,
      stakeRaw: amountRaw.toString(),
      computedRewardRaw: computedRewardRaw.toString(),
    });
  }

  // 4) 强守恒校验：全量核验后的有效参与者锁仓总和必须严格等于主控合约的 totalStakeRaw
  if (sumStake !== totalStakeRaw) {
    throw new V17RewardError(
      'STAKE_CONSERVATION_MISMATCH',
      `verified participant stake sum (${sumStake}) != on-chain round.totalStakeRaw (${totalStakeRaw})`,
    );
  }

  // 5) 服务端派生可公开复算的空投种子
  const airdropSeedHash = await sha256HexAsync(
    `a9-v17-airdrop-seed:${net}:${rcKey}:${rId}:${settlementTxHash}:${candleHash}`,
  );

  const core = {
    version: V17_FINALITY_SNAPSHOT_VERSION,
    network: net,
    roundController: rcKey,
    roundId: rId,
    statusCode,
    settledAt,
    settlementTxHash,
    candleHash,
    totalStakeRaw: totalStakeRaw.toString(),
    rewardBudgetRaw: rewardBudgetRaw.toString(),
    participantCount: participants.length,
    participants,
    airdropSeedHash,
  };
  const evidenceHash = await sha256HexAsync(core);

  const trustedSnapshot = deepFreeze({
    ...core,
    evidenceHash,
  });
  TRUSTED_CHAIN_SNAPSHOTS.add(trustedSnapshot);
  return trustedSnapshot;
}

/**
 * 持久化并锁定轮次终局快照（入口先验真快照完整性，防伪造写入）。
 */
export async function persistOrVerifyFinalitySnapshot(db, snapshot, nowSec = Math.floor(Date.now() / 1000)) {
  if (!db) throw new V17RewardError('STORAGE_ERROR', 'D1 database binding is required');
  await verifyRoundFinalitySnapshotIntegrity(snapshot);

  await db
    .prepare(
      `INSERT OR IGNORE INTO v17_round_finality_snapshots
         (round_id, network, round_controller, status_code, settled_at, settlement_tx_hash,
          candle_hash, total_stake_raw, reward_budget_raw, participant_count,
          airdrop_seed_hash, evidence_hash, snapshot_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      snapshot.roundId,
      snapshot.network,
      snapshot.roundController,
      snapshot.statusCode,
      snapshot.settledAt,
      snapshot.settlementTxHash,
      snapshot.candleHash,
      snapshot.totalStakeRaw,
      snapshot.rewardBudgetRaw,
      snapshot.participantCount,
      snapshot.airdropSeedHash,
      snapshot.evidenceHash,
      canonicalStringify(snapshot),
      Number(nowSec),
    )
    .run();

  const existing = await db
    .prepare('SELECT * FROM v17_round_finality_snapshots WHERE round_id = ? LIMIT 1')
    .bind(snapshot.roundId)
    .first();
  if (!existing) {
    throw new V17RewardError('STORAGE_ERROR', 'failed to load persisted finality snapshot');
  }
  if (
    String(existing.evidence_hash) !== snapshot.evidenceHash ||
    String(existing.network) !== snapshot.network ||
    String(existing.round_controller) !== snapshot.roundController
  ) {
    throw new V17RewardError(
      'FINALITY_EVIDENCE_CONFLICT',
      `round #${snapshot.roundId} already locked with evidence ${existing.evidence_hash}, refusing conflicting ${snapshot.evidenceHash}`,
    );
  }
  return existing;
}

/**
 * 基于已核验的链上终局快照，原子批量结算整轮 8% 好友通关返佣。
 * 强制校验：同库预算、预期网络/主控绑定、可信链来源（可传入 chainReader+roundId 现场读取，或传入 buildVerifiedRoundFinalitySnapshot 生成的不可变快照）。
 */
export async function settleVerifiedStakeReferralsBatch({
  db,
  budgetLedger,
  expectedNetwork,
  expectedRoundController,
  snapshot = null,
  chainReader = null,
  roundId = null,
  resolveReferrerWallet,
  nowSec = Math.floor(Date.now() / 1000),
}) {
  if (!db) throw new V17RewardError('STORAGE_ERROR', 'D1 database binding is required');
  assertSameDbBudgetLedger(db, budgetLedger);

  const resolvedSnapshot = chainReader
    ? await buildVerifiedRoundFinalitySnapshot({
        network: expectedNetwork,
        roundController: expectedRoundController,
        roundId,
        chainReader,
      })
    : snapshot;

  assertTrustedChainSnapshotOrigin(resolvedSnapshot, { expectedNetwork, expectedRoundController });
  await verifyRoundFinalitySnapshotIntegrity(resolvedSnapshot);
  snapshot = resolvedSnapshot;

  if (typeof resolveReferrerWallet !== 'function') {
    throw new V17RewardError('REFERRER_RESOLVER_REQUIRED', 'server-side resolveReferrerWallet is required');
  }

  await persistOrVerifyFinalitySnapshot(db, snapshot, nowSec);

  if (snapshot.statusCode !== RC_STATUS_SUCCEEDED) {
    return {
      roundId: snapshot.roundId,
      evidenceHash: snapshot.evidenceHash,
      statusCode: snapshot.statusCode,
      creditedCount: 0,
      duplicateCount: 0,
      totalCommissionRaw: '0',
      items: [],
    };
  }

  const planned = [];
  for (const p of snapshot.participants) {
    const rewardBig = BigInt(String(p.computedRewardRaw || '0'));
    if (rewardBig <= 0n) continue;
    const refWallet = await resolveReferrerWallet(p.walletAddress, p.walletKey);
    if (!refWallet || !normalizeTonAddress(refWallet)) continue;
    const refKey = addressKey(refWallet);
    if (refKey === p.walletKey) continue;
    const commissionBig = computeStakeReferralCommissionRaw(rewardBig);
    if (commissionBig <= 0n) continue;
    planned.push({
      creditId: buildStakeReferralCreditId(snapshot.roundId, p.walletAddress),
      roundId: snapshot.roundId,
      referrerWallet: refWallet,
      referrerKey: refKey,
      refereeWallet: p.walletAddress,
      refereeRewardRaw: rewardBig.toString(),
      commissionBig,
    });
  }

  if (planned.length === 0) {
    return {
      roundId: snapshot.roundId,
      evidenceHash: snapshot.evidenceHash,
      statusCode: snapshot.statusCode,
      creditedCount: 0,
      duplicateCount: 0,
      totalCommissionRaw: '0',
      items: [],
    };
  }

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const pendingItems = [];
    const duplicateItems = [];
    for (const item of planned) {
      const existing = await db
        .prepare('SELECT * FROM stake_referral_credits WHERE credit_id = ? LIMIT 1')
        .bind(item.creditId)
        .first();
      if (existing && String(existing.status) === 'CREDITED') {
        duplicateItems.push(existing);
      } else {
        pendingItems.push({ ...item, hasPendingRow: Boolean(existing) });
      }
    }

    if (pendingItems.length === 0) {
      return {
        roundId: snapshot.roundId,
        evidenceHash: snapshot.evidenceHash,
        statusCode: snapshot.statusCode,
        creditedCount: 0,
        duplicateCount: duplicateItems.length,
        totalCommissionRaw: '0',
        duplicate: true,
        items: duplicateItems.map((r) => ({
          creditId: String(r.credit_id),
          referrerWallet: String(r.referrer_wallet),
          commissionRaw: String(r.commission_raw),
          status: String(r.status),
          duplicate: true,
        })),
      };
    }

    let batchTotalCommission = 0n;
    const deltaByReferrer = new Map();
    for (const item of pendingItems) {
      batchTotalCommission += item.commissionBig;
    }

    // 强制同库预算预检：超预算整批原子失败，绝不跳过
    const budgetPrep = await budgetLedger.prepareAtomicReserve('stake_referral', batchTotalCommission.toString(), nowSec);
    if (!budgetPrep) {
      throw new V17RewardError('BUDGET_LEDGER_REQUIRED', 'budget ledger did not return atomic reserve plan');
    }

    for (const item of pendingItems) {
      const aliases = Array.from(new Set([item.referrerKey, item.referrerWallet, ...addressAliases(item.referrerWallet)].filter(Boolean)));
      const placeholders = aliases.map(() => '?').join(', ');
      let balRow = await db
        .prepare(`SELECT wallet_address, claimable_raw FROM promo_balances WHERE wallet_address IN (${placeholders}) LIMIT 1`)
        .bind(...aliases)
        .first();
      if (!balRow) {
        await db
          .prepare(
            `INSERT OR IGNORE INTO promo_balances (wallet_address, claimable_raw, total_claimed_raw, updated_at)
             VALUES (?, '0', '0', ?)`,
          )
          .bind(item.referrerKey, nowSec)
          .run();
        balRow = await db
          .prepare(`SELECT wallet_address, claimable_raw FROM promo_balances WHERE wallet_address IN (${placeholders}) LIMIT 1`)
          .bind(...aliases)
          .first();
      }
      if (!balRow) throw new V17RewardError('STORAGE_ERROR', 'failed to initialize promo_balances row');
      const balWallet = String(balRow.wallet_address);
      const prev = deltaByReferrer.get(balWallet);
      if (prev) {
        prev.addBig += item.commissionBig;
      } else {
        deltaByReferrer.set(balWallet, {
          balWallet,
          curStr: String(balRow.claimable_raw || '0'),
          addBig: item.commissionBig,
        });
      }
    }

    const stmts = [
      db
        .prepare(
          `UPDATE promo_budget_ledger
           SET spent_raw = CASE WHEN spent_raw = ? THEN ? ELSE NULL END,
               updated_at = ?
           WHERE bucket_key = ?`,
        )
        .bind(budgetPrep.curSpentStr, budgetPrep.nextSpentStr, nowSec, budgetPrep.bucketKey),
    ];

    for (const item of pendingItems) {
      if (item.hasPendingRow) {
        stmts.push(
          db
            .prepare(
              `UPDATE stake_referral_credits
               SET status = CASE WHEN status = 'PENDING' THEN 'CREDITED' ELSE NULL END
               WHERE credit_id = ?`,
            )
            .bind(item.creditId),
        );
      } else {
        stmts.push(
          db
            .prepare(
              `INSERT INTO stake_referral_credits
                 (credit_id, round_id, referrer_wallet, referee_wallet, referee_reward_raw, commission_raw, status, created_at)
               VALUES (?, ?, ?, ?, ?, ?, 'CREDITED', ?)`,
            )
            .bind(
              item.creditId,
              item.roundId,
              item.referrerWallet,
              item.refereeWallet,
              item.refereeRewardRaw,
              item.commissionBig.toString(),
              Number(nowSec),
            ),
        );
      }
    }

    for (const entry of deltaByReferrer.values()) {
      const nextStr = (BigInt(entry.curStr) + entry.addBig).toString();
      stmts.push(
        db
          .prepare(
            `UPDATE promo_balances
             SET claimable_raw = CASE WHEN claimable_raw = ? THEN ? ELSE NULL END,
                 updated_at = ?
             WHERE wallet_address = ?`,
          )
          .bind(entry.curStr, nextStr, nowSec, entry.balWallet),
      );
    }

    try {
      const res = await db.batch(stmts);
      if (res.every((r) => changes(r) === 1)) {
        return {
          roundId: snapshot.roundId,
          evidenceHash: snapshot.evidenceHash,
          statusCode: snapshot.statusCode,
          creditedCount: pendingItems.length,
          duplicateCount: duplicateItems.length,
          totalCommissionRaw: batchTotalCommission.toString(),
          duplicate: false,
          items: pendingItems.map((it) => ({
            creditId: it.creditId,
            referrerWallet: it.referrerWallet,
            commissionRaw: it.commissionBig.toString(),
            status: 'CREDITED',
            duplicate: false,
          })),
        };
      }
    } catch (e) {
      if (e instanceof BudgetError) throw e;
      if (!/NOT NULL|UNIQUE|constraint/i.test(String(e?.message || e))) throw e;
      continue;
    }
  }

  throw new V17RewardError('CONFLICT', 'verified stake referral batch CAS conflict, please retry');
}

/**
 * 基于已核验的链上终局快照，原子执行单轮等权空投抽奖。
 * 强制校验：同库预算、预期网络/主控绑定、可信链来源（可传入 chainReader+roundId 现场读取，或传入可信快照）。
 */
export async function drawVerifiedRoundAirdrop({
  db,
  budgetLedger,
  expectedNetwork,
  expectedRoundController,
  snapshot = null,
  chainReader = null,
  roundId = null,
  prizeRaw = DEFAULT_AIRDROP_PRIZE_RAW,
  nowSec = Math.floor(Date.now() / 1000),
}) {
  if (!db) throw new V17RewardError('STORAGE_ERROR', 'D1 database binding is required');
  assertSameDbBudgetLedger(db, budgetLedger);

  const resolvedSnapshot = chainReader
    ? await buildVerifiedRoundFinalitySnapshot({
        network: expectedNetwork,
        roundController: expectedRoundController,
        roundId,
        chainReader,
      })
    : snapshot;

  assertTrustedChainSnapshotOrigin(resolvedSnapshot, { expectedNetwork, expectedRoundController });
  await verifyRoundFinalitySnapshotIntegrity(resolvedSnapshot);
  snapshot = resolvedSnapshot;

  await persistOrVerifyFinalitySnapshot(db, snapshot, nowSec);

  if (snapshot.statusCode === RC_STATUS_ABORTED || snapshot.participants.length === 0) {
    throw new V17RewardError('NO_PARTICIPANTS', `round #${snapshot.roundId} has no eligible participants for airdrop`);
  }

  const prizeBig = BigInt(String(prizeRaw || '0'));
  if (prizeBig <= 0n) {
    throw new V17RewardError('BAD_AMOUNT', 'prizeRaw must be positive');
  }

  const participantWallets = snapshot.participants.map((p) => p.walletAddress);
  const picked = await pickDeterministicAirdropWinner(
    snapshot.roundId,
    participantWallets,
    snapshot.airdropSeedHash,
  );

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const existing = await db
      .prepare('SELECT * FROM round_jackpot_draws WHERE round_id = ? LIMIT 1')
      .bind(snapshot.roundId)
      .first();
    if (existing && String(existing.status) === 'CREDITED') {
      if (String(existing.seed_hash) !== snapshot.airdropSeedHash) {
        throw new V17RewardError(
          'FINALITY_EVIDENCE_CONFLICT',
          `existing airdrop draw seed_hash (${existing.seed_hash}) conflicts with snapshot (${snapshot.airdropSeedHash})`,
        );
      }
      return {
        roundId: snapshot.roundId,
        evidenceHash: snapshot.evidenceHash,
        seedHash: String(existing.seed_hash),
        winnerWallet: String(existing.winner_wallet),
        prizeRaw: String(existing.prize_raw),
        status: 'CREDITED',
        duplicate: true,
      };
    }

    const budgetPrep = await budgetLedger.prepareAtomicReserve('round_airdrop', prizeBig.toString(), nowSec);
    if (!budgetPrep) {
      throw new V17RewardError('BUDGET_LEDGER_REQUIRED', 'budget ledger did not return atomic reserve plan');
    }

    const winnerKey = addressKey(picked.winnerWallet);
    const aliases = Array.from(new Set([winnerKey, picked.winnerWallet, ...addressAliases(picked.winnerWallet)].filter(Boolean)));
    const placeholders = aliases.map(() => '?').join(', ');
    let balRow = await db
      .prepare(`SELECT wallet_address, claimable_raw FROM promo_balances WHERE wallet_address IN (${placeholders}) LIMIT 1`)
      .bind(...aliases)
      .first();
    if (!balRow) {
      await db
        .prepare(
          `INSERT OR IGNORE INTO promo_balances (wallet_address, claimable_raw, total_claimed_raw, updated_at)
           VALUES (?, '0', '0', ?)`,
        )
        .bind(winnerKey, nowSec)
        .run();
      balRow = await db
        .prepare(`SELECT wallet_address, claimable_raw FROM promo_balances WHERE wallet_address IN (${placeholders}) LIMIT 1`)
        .bind(...aliases)
        .first();
    }
    if (!balRow) throw new V17RewardError('STORAGE_ERROR', 'failed to initialize winner promo_balances row');

    const balWallet = String(balRow.wallet_address);
    const curBalStr = String(balRow.claimable_raw || '0');
    const nextBalStr = (BigInt(curBalStr) + prizeBig).toString();

    const stmts = [
      db
        .prepare(
          `UPDATE promo_budget_ledger
           SET spent_raw = CASE WHEN spent_raw = ? THEN ? ELSE NULL END,
               updated_at = ?
           WHERE bucket_key = ?`,
        )
        .bind(budgetPrep.curSpentStr, budgetPrep.nextSpentStr, nowSec, budgetPrep.bucketKey),
    ];
    if (existing) {
      stmts.push(
        db
          .prepare(
            `UPDATE round_jackpot_draws
             SET status = CASE WHEN status = 'PENDING' AND seed_hash = ? THEN 'CREDITED' ELSE NULL END
             WHERE round_id = ?`,
          )
          .bind(snapshot.airdropSeedHash, snapshot.roundId),
      );
    } else {
      stmts.push(
        db
          .prepare(
            `INSERT INTO round_jackpot_draws
               (round_id, seed_hash, winner_wallet, prize_raw, status, created_at)
             VALUES (?, ?, ?, ?, 'CREDITED', ?)`,
          )
          .bind(snapshot.roundId, snapshot.airdropSeedHash, picked.winnerWallet, prizeBig.toString(), Number(nowSec)),
      );
    }
    stmts.push(
      db
        .prepare(
          `UPDATE promo_balances
           SET claimable_raw = CASE WHEN claimable_raw = ? THEN ? ELSE NULL END,
               updated_at = ?
           WHERE wallet_address = ?`,
        )
        .bind(curBalStr, nextBalStr, nowSec, balWallet),
    );

    try {
      const res = await db.batch(stmts);
      if (res.every((r) => changes(r) === 1)) {
        return {
          roundId: snapshot.roundId,
          evidenceHash: snapshot.evidenceHash,
          seedHash: snapshot.airdropSeedHash,
          winnerWallet: picked.winnerWallet,
          prizeRaw: prizeBig.toString(),
          status: 'CREDITED',
          duplicate: false,
        };
      }
    } catch (e) {
      if (e instanceof BudgetError) throw e;
      if (!/NOT NULL|UNIQUE|constraint/i.test(String(e?.message || e))) throw e;
      continue;
    }
  }

  throw new V17RewardError('CONFLICT', 'verified round airdrop CAS conflict, please retry');
}
