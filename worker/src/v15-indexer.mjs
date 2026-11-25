// A9 Protocol v15 — On-chain state mapper (RoundController v15 -> a9-mini-app API view).

export const V15_STATUS = Object.freeze({
  0: 'UNOPENED',
  1: 'ACTIVE',
  2: 'SUCCEEDED',
  3: 'FAILED',
  4: 'ABORTED',
});

/**
 * Derive UI-compatible round state from v15's 4-state contract + current timestamp.
 * In v15, staking automatically transitions to observing at stakeCloseAt without CloseStaking tx,
 * and SettleRound settles immediately without a 6h SETTLING delay.
 */
export function deriveRoundStage(round, nowSec, observationSeconds = 86400) {
  const statusCode = Number(round.status);
  if (statusCode === 0) return { state: 'UNOPENED', nextState: 'STAKING_OPEN', secondsRemaining: null };
  if (statusCode === 2) return { state: 'SUCCEEDED', nextState: null, secondsRemaining: 0 };
  if (statusCode === 3) return { state: 'FAILED_PERMANENT', nextState: null, secondsRemaining: 0 };
  if (statusCode === 4) return { state: 'TECHNICAL_ABORTED', nextState: null, secondsRemaining: 0 };

  const closeAt = Number(round.stakeCloseAt);
  const obsEnd = closeAt + Number(observationSeconds);
  if (nowSec < closeAt) {
    return { state: 'STAKING_OPEN', nextState: 'OBSERVING', secondsRemaining: closeAt - nowSec };
  }
  if (nowSec < obsEnd) {
    return { state: 'OBSERVING', nextState: 'SETTLED', secondsRemaining: obsEnd - nowSec };
  }
  return { state: 'OBSERVING', nextState: 'AWAITING_SETTLE', secondsRemaining: 0 };
}

export function mapV15RoundDetail(roundId, round, candles = [], nowSec = Math.floor(Date.now() / 1000), timing = {}) {
  const obsSec = Number(timing.observationSeconds ?? 86400);
  const derived = deriveRoundStage(round, nowSec, obsSec);
  const qualifiedFromCandles = candles.filter((c) => Boolean(c.qualified)).length;
  const qualified = Number(round.status) >= 2 ? Number(round.qualifiedCandles || 0) : qualifiedFromCandles;

  const twapRaw = BigInt(round.twap24hUsdE8 || 0);
  return {
    roundId: Number(roundId),
    state: derived.state,
    nextState: derived.nextState,
    secondsRemaining: derived.secondsRemaining,
    targetLocked: Number(round.status) !== 0,
    targetPriceUsdE8: String(round.targetPriceUsdE8 ?? '0'),
    priceUsdE8: twapRaw > 0n ? twapRaw.toString() : null,
    priceValid: twapRaw > 0n,
    stakeOpenAt: Number(round.stakeOpenAt || 0),
    stakeCloseAt: Number(round.stakeCloseAt || 0),
    settledAt: Number(round.settledAt || 0),
    totalAcceptedStakeRaw: String(round.totalStakeRaw ?? '0'),
    totalWeightRaw: String(round.totalWeightRaw ?? '0'),
    rewardBudgetRaw: String(round.rewardBudgetRaw ?? '0'),
    candlesSeen: candles.length,
    qualifiedCandles: qualified,
    candles,
    candleHash: round.candleHash || '0x0',
    unlock: {
      model: 'LINEAR_40D',
      immediateBps: Number(round.immediateBps || 0),
      dailyUnlockBps: 200,
      vestingSeconds: Number(round.vestingSeconds ?? timing.vestingSeconds ?? 3456000),
      lockedTotalRaw: String(round.lockedTotalRaw ?? '0'),
      lockedSlices: 0,
      unlockedSlices: 0,
      burnedSlices: 0,
    },
    entryCount: Number(round.stakeCount || 0),
    updatedAt: nowSec * 1000,
  };
}

export function resolveProtocolVersion(rawValue, defaultVersion = 'v16') {
  const raw = String(rawValue ?? '').trim().toLowerCase();
  if (!raw) return defaultVersion;
  if (raw === 'v16') return 'v16';
  throw new Error(`Unsupported A9_PROTOCOL_VERSION: "${rawValue}" (expected "v16")`);
}

/**
 * 1:1 镜像 RoundController.tolk v16.2（20% 即时 + 80% 40 天按秒线性释放，永久累计不倒扣）。
 * 防止前端对观察中 / 失败销毁 / 已全额领完的 StakeTicket 发起必败 0.22 GRAM 领奖交易。
 */
export function computeTicketClaimPreview(
  ticket,
  round,
  _protocolState = null,
  nowSec = Math.floor(Date.now() / 1000),
  { observationSeconds = 86400, vestingSeconds = 40 * 86400 } = {},
) {
  const defaultVestSec = Number(round?.vestingSeconds ?? vestingSeconds ?? 40 * 86400);
  if (!ticket || !round) {
    return {
      roundState: 'UNKNOWN',
      canClaim: false,
      claimablePrincipalRaw: '0',
      claimableRewardRaw: '0',
      claimableTotalRaw: '0',
      lockedRemainingRaw: '0',
      burnedLockedRaw: '0',
      vestingSeconds: defaultVestSec,
      unlockedPctBps: 0,
    };
  }
  const derived = deriveRoundStage(round, nowSec, observationSeconds);
  const status = Number(round.status);
  if (status !== 2 && status !== 4) {
    return {
      roundState: derived.state,
      canClaim: false,
      claimablePrincipalRaw: '0',
      claimableRewardRaw: '0',
      claimableTotalRaw: '0',
      lockedRemainingRaw: '0',
      burnedLockedRaw: '0',
      vestingSeconds: defaultVestSec,
      unlockedPctBps: 0,
    };
  }

  const amountRaw = BigInt(ticket.amountRaw || '0');
  const weightRaw = BigInt(ticket.weightRaw || '0');
  const payPrincipal = !ticket.principalDone ? amountRaw : 0n;
  let payReward = 0n;
  let lockedRemaining = 0n;
  let unlockedPctBps = 0;

  if (status === 2) {
    const totalWeightRaw = BigInt(round.totalWeightRaw || '0');
    const rewardBudgetRaw = BigInt(round.rewardBudgetRaw || '0');
    if (totalWeightRaw > 0n && weightRaw > 0n) {
      const totalReward = (rewardBudgetRaw * weightRaw) / totalWeightRaw;
      const immBps = BigInt(Number(round.immediateBps || 2000));
      const imm = (totalReward * immBps) / 10000n;
      const locked = totalReward - imm;

      if (!ticket.immediateClaimed) {
        payReward += imm;
      }

      const settledAt = Number(round.settledAt || 0);
      let unlockedNow = 0n;
      if (locked > 0n && settledAt > 0 && nowSec > settledAt) {
        const elapsed = BigInt(nowSec - settledAt);
        const dur = BigInt(Math.max(0, defaultVestSec));
        unlockedNow = (dur === 0n || elapsed >= dur) ? locked : (locked * elapsed) / dur;
      }

      const lockedClaimed = BigInt(ticket.lockedClaimedRaw ?? ticket.rewardClaimedRaw ?? '0');
      if (unlockedNow > lockedClaimed) {
        payReward += unlockedNow - lockedClaimed;
      }
      lockedRemaining = locked > unlockedNow ? locked - unlockedNow : 0n;
      if (totalReward > 0n) {
        unlockedPctBps = Number(((imm + unlockedNow) * 10000n) / totalReward);
      }
    }
  }

  const claimableTotal = payPrincipal + payReward;
  return {
    roundState: derived.state,
    canClaim: !ticket.pending && claimableTotal > 0n,
    claimablePrincipalRaw: payPrincipal.toString(),
    claimableRewardRaw: payReward.toString(),
    claimableTotalRaw: claimableTotal.toString(),
    lockedRemainingRaw: lockedRemaining.toString(),
    burnedLockedRaw: '0',
    vestingSeconds: defaultVestSec,
    unlockedPctBps,
  };
}

export function buildV15ConfigPayload(env = {}, protocolState = null) {
  const A9 = 1_000_000_000n;
  const proto = resolveProtocolVersion(env.A9_PROTOCOL_VERSION, 'v16');
  const maxRoundId = proto === 'v16' ? 4294967295 : 255;
  const ps = protocolState && typeof protocolState === 'object' ? protocolState : null;
  const dataAvailable = Boolean(
    ps &&
      ps.dataAvailable !== false &&
      (ps.poolRemainingRaw !== undefined && ps.poolRemainingRaw !== null),
  );
  return {
    protocolVersion: proto,
    stakeProtocolVersion: proto,
    maxRoundId,
    network: env.A9_NETWORK || 'testnet',
    botHandle: String(env.A9_TG_BOT_HANDLE || 'A9_TonBot').replace(/^@/, '').trim() || 'A9_TonBot',
    openEnded: true,
    roundCount: null, // runs until 7B reward pool is exhausted (protocol maxRoundId cap exposed explicitly)
    candleCount: 24,
    minQualifiedCandles: 16,
    maxRewardCapMultiplier: 15,
    unlockModel: 'LINEAR_40D',
    immediateBps: 2000,
    dailyUnlockBps: 200,
    vestingSeconds: Number(env.A9_VESTING_SECONDS || 3456000),
    roundRewardRaw: String(700_000_000n * A9),
    teamRoundRaw: String(120_000_000n * A9),
    minStakeRaw: String(1_000n * A9),
    token: { symbol: 'A9', decimals: 9 },
    contracts: {
      jettonMaster: env.A9_JETTON_MASTER_ADDRESS || null,
      roundController: env.A9_ROUND_CONTROLLER_ADDRESS || null,
      stakingEnabled: Boolean(env.A9_ROUND_CONTROLLER_ADDRESS),
    },
    promoHotWallet: {
      enabled: Boolean(env.A9_PROMO_HOT_WALLET_ADDRESS),
      address: env.A9_PROMO_HOT_WALLET_ADDRESS || null,
      userFeeNano: String(env.A9_PROMO_USER_FEE_NANO || '60000000'), // 0.06 GRAM
      userFeeTon: (() => {
        const nano = BigInt(String(env.A9_PROMO_USER_FEE_NANO || '60000000'));
        const whole = nano / 1_000_000_000n;
        const frac = String(nano % 1_000_000_000n).padStart(9, '0').replace(/0+$/, '');
        return frac ? `${whole}.${frac}` : whole.toString();
      })(),
    },
    // 无链上数据源时明确返回 dataAvailable=false 和 null，绝不用默认 70 亿/12 亿伪造实时链上剩余奖池（P0-G）。
    poolState: dataAvailable
      ? {
          dataAvailable: true,
          currentRoundId: Number(ps.currentRoundId || 0),
          successCount: Number(ps.successCount || 0),
          poolRemainingRaw: String(ps.poolRemainingRaw),
          carryRaw: ps.carryRaw !== undefined && ps.carryRaw !== null ? String(ps.carryRaw) : null,
          teamPoolRemainingRaw: ps.teamPoolRemainingRaw !== undefined && ps.teamPoolRemainingRaw !== null ? String(ps.teamPoolRemainingRaw) : null,
          teamCarryRaw: ps.teamCarryRaw !== undefined && ps.teamCarryRaw !== null ? String(ps.teamCarryRaw) : null,
          lastSuccessAt: Number(ps.lastSuccessAt || 0),
          endAt: Number(ps.endAt || 0),
          pendingTeamReleaseRaw: ps.pendingTeamReleaseRaw !== undefined && ps.pendingTeamReleaseRaw !== null ? String(ps.pendingTeamReleaseRaw) : '0',
          pendingBurnRaw: ps.pendingBurnRaw !== undefined && ps.pendingBurnRaw !== null ? String(ps.pendingBurnRaw) : '0',
          activeLockedRoundsRaw: ps.activeLockedRoundsRaw !== undefined && ps.activeLockedRoundsRaw !== null
            ? String(ps.activeLockedRoundsRaw)
            : (ps.activeLockedRounds !== undefined && ps.activeLockedRounds !== null ? String(ps.activeLockedRounds) : '0'),
        }
      : {
          dataAvailable: false,
          currentRoundId: null,
          successCount: null,
          poolRemainingRaw: null,
          carryRaw: null,
          teamPoolRemainingRaw: null,
          teamCarryRaw: null,
          lastSuccessAt: null,
          endAt: null,
          pendingTeamReleaseRaw: null,
          pendingBurnRaw: null,
          activeLockedRoundsRaw: null,
        },
  };
}
