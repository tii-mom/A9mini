// A9 Protocol v17 — On-chain state mapper (RoundController v17 Price-Unlock -> a9-mini-app API view).

export const V15_STATUS = Object.freeze({
  0: 'UNOPENED',
  1: 'ACTIVE',
  2: 'SUCCEEDED',
  3: 'FAILED',
  4: 'ABORTED',
});

/**
 * Derive UI-compatible round state from v17's 4-state contract + current timestamp.
 * 24H Lock (First 6H 5% Stop-Loss / Late 10% Stop-Loss) -> 12H Push (locked, no entry/exit) -> SettleRound.
 */
export function deriveRoundStage(round, nowSec, observationSeconds = 43200) {
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
  const obsSec = Number(timing.observationSeconds ?? 43200);
  const earlyWindowSec = Number(round.earlyWindowSeconds ?? timing.earlyWindowSeconds ?? 21600);
  const vestingSec = Number(round.vestingSeconds ?? timing.vestingSeconds ?? 1209600);
  const derived = deriveRoundStage(round, nowSec, obsSec);
  const qualifiedFromCandles = candles.filter((c) => Boolean(c.qualified)).length;
  const qualified = Number(round.status) >= 2 ? Number(round.qualifiedCandles || 0) : qualifiedFromCandles;

  const stakeOpenAt = Number(round.stakeOpenAt || 0);
  const earlyCloseAt = stakeOpenAt > 0 ? stakeOpenAt + earlyWindowSec : 0;
  const inFirst6h = derived.state === 'STAKING_OPEN' && earlyCloseAt > 0 && nowSec < earlyCloseAt;
  const earlySecondsRemaining = inFirst6h ? Math.max(0, earlyCloseAt - nowSec) : 0;

  const twapRaw = BigInt(round.twap24hUsdE8 || 0);
  const totalStakeRaw = String(round.totalStakeRaw ?? '0');
  const earlyStakeRaw = String(round.earlyStakeRaw ?? '0');

  return {
    roundId: Number(roundId),
    state: derived.state,
    nextState: derived.nextState,
    secondsRemaining: derived.secondsRemaining,
    targetLocked: Number(round.status) !== 0,
    targetPriceUsdE8: String(round.targetPriceUsdE8 ?? '0'),
    priceUsdE8: twapRaw > 0n ? twapRaw.toString() : null,
    priceValid: twapRaw > 0n,
    stakeOpenAt,
    stakeCloseAt: Number(round.stakeCloseAt || 0),
    earlyCloseAt,
    earlyWindowSeconds: earlyWindowSec,
    inFirst6h,
    earlySecondsRemaining,
    settledAt: Number(round.settledAt || 0),
    totalAcceptedStakeRaw: totalStakeRaw,
    earlyStakeRaw,
    totalWeightRaw: String(round.totalWeightRaw ?? totalStakeRaw),
    rewardBudgetRaw: String(round.rewardBudgetRaw ?? '0'),
    candlesSeen: candles.length,
    qualifiedCandles: qualified,
    candles,
    candleHash: round.candleHash || '0x0',
    unlock: {
      model: 'LINEAR_14D',
      immediateBps: Number(round.immediateBps || 2000),
      dailyUnlockBps: 571,
      vestingSeconds: vestingSec,
      lockedTotalRaw: String(round.lockedTotalRaw ?? '0'),
      instantDiscountBps: 3000,
      lockedSlices: 0,
      unlockedSlices: 0,
      burnedSlices: 0,
    },
    stopLoss: {
      earlyBurnBps: 500,
      lateBurnBps: 1000,
      earlyExitBurnBps: 1500,
    },
    entryCount: Number(round.stakeCount || 0),
    updatedAt: nowSec * 1000,
  };
}

export function resolveProtocolVersion(rawValue, defaultVersion = 'v17') {
  const raw = String(rawValue ?? '').trim().toLowerCase();
  if (!raw) return defaultVersion;
  if (raw === 'v17' || raw === 'v16') return raw;
  throw new Error(`Unsupported A9_PROTOCOL_VERSION: "${rawValue}" (expected "v17" or "v16")`);
}

/**
 * 1:1 镜像 RoundController.tolk v17.0（涨价解锁）：
 * - ACTIVE（仅限 nowSec < stakeCloseAt 24H 锁仓期内）：支持提前解押（退 85% 本金 / 扣 15% 销毁）
 * - FAILED：头矿退 95% / 普通退 90%（分段精确核算）
 * - ABORTED：100% 无损退本
 * - SUCCEEDED：全员 1:1 平分（封顶 5x）、20% 秒提 + 14 天逐秒解锁；支持未解锁部分 3 折急提（7 折销毁），满 14 天后 0 销毁
 */
export function computeTicketClaimPreview(
  ticket,
  round,
  _protocolState = null,
  nowSec = Math.floor(Date.now() / 1000),
  { observationSeconds = 43200, vestingSeconds = 14 * 86400 } = {},
) {
  const defaultVestSec = Number(round?.vestingSeconds ?? vestingSeconds ?? 14 * 86400);
  const empty = (roundState = 'UNKNOWN') => ({
    roundState,
    canClaim: false,
    canEarlyExit: false,
    earlyExitRefundRaw: '0',
    earlyExitBurnRaw: '0',
    claimablePrincipalRaw: '0',
    burnedPrincipalRaw: '0',
    claimableRewardRaw: '0',
    claimableTotalRaw: '0',
    lockedRemainingRaw: '0',
    canInstantCashout: false,
    instantCashoutTotalRaw: '0',
    instantCashoutBonusRaw: '0',
    instantCashoutBurnRaw: '0',
    burnedLockedRaw: '0',
    vestingSeconds: defaultVestSec,
    unlockedPctBps: 0,
    vestingStartAt: null,
    vestingPrincipalRaw: null,
  });

  if (!ticket || !round) return empty('UNKNOWN');
  const derived = deriveRoundStage(round, nowSec, observationSeconds);
  const status = Number(round.status);

  const amountRaw = BigInt(ticket.amountRaw || '0');
  const hasSplit = ticket.earlyAmountRaw !== undefined || ticket.lateAmountRaw !== undefined;
  const earlyAmountRaw = hasSplit ? BigInt(ticket.earlyAmountRaw || '0') : 0n;
  const lateAmountRaw = hasSplit ? BigInt(ticket.lateAmountRaw || '0') : amountRaw;
  const totalAmt = earlyAmountRaw + lateAmountRaw > 0n ? (earlyAmountRaw + lateAmountRaw) : amountRaw;

  // 1) ACTIVE 阶段：仅限 24H 锁仓期内 (nowSec < stakeCloseAt) 可提前解押（退 85% / 烧 15%）
  if (status === 1) {
    const closeAt = Number(round.stakeCloseAt || 0);
    const canEarlyExit = !ticket.pending && !ticket.exited && totalAmt > 0n && closeAt > 0 && nowSec < closeAt;
    const earlyExitRefund = canEarlyExit ? (totalAmt * 8500n) / 10000n : 0n;
    const earlyExitBurn = canEarlyExit ? (totalAmt - earlyExitRefund) : 0n;
    return {
      ...empty(derived.state),
      canEarlyExit,
      earlyExitRefundRaw: earlyExitRefund.toString(),
      earlyExitBurnRaw: earlyExitBurn.toString(),
    };
  }

  if (status !== 2 && status !== 3 && status !== 4) {
    return empty(derived.state);
  }

  // 2) FAILED 阶段：永不爆仓，头矿退 95%（烧 5%）、普通退 90%（烧 10%）
  if (status === 3) {
    if (ticket.principalDone || ticket.exited || totalAmt <= 0n) {
      return empty(derived.state);
    }
    const earlyRef = (earlyAmountRaw * 9500n) / 10000n;
    const lateRef = (lateAmountRaw * 9000n) / 10000n;
    const payPrincipal = earlyRef + lateRef;
    const burnedPrincipal = totalAmt - payPrincipal;
    return {
      ...empty(derived.state),
      canClaim: !ticket.pending && payPrincipal > 0n,
      claimablePrincipalRaw: payPrincipal.toString(),
      burnedPrincipalRaw: burnedPrincipal.toString(),
      claimableTotalRaw: payPrincipal.toString(),
    };
  }

  // 3) ABORTED 阶段：7 天超时逃生门，100% 无损退本
  const payPrincipal = (!ticket.principalDone && !ticket.exited) ? totalAmt : 0n;
  let payReward = 0n;
  let lockedRemaining = 0n;
  let unlockedPctBps = 0;
  let vestingPrincipalRaw = null;
  let vestingStartAt = null;
  let canInstantCashout = false;
  let instantCashoutBonus = 0n;
  let instantCashoutBurn = 0n;

  // 4) SUCCEEDED 阶段：全员 1:1 平分，20% 秒提 + 14 天逐秒解锁 + 3 折急提
  if (status === 2 && !ticket.exited && totalAmt > 0n) {
    const totalStakeRaw = BigInt(round.totalStakeRaw || round.totalWeightRaw || '0');
    const rewardBudgetRaw = BigInt(round.rewardBudgetRaw || '0');
    if (totalStakeRaw > 0n) {
      const totalReward = (rewardBudgetRaw * totalAmt) / totalStakeRaw;
      const immBps = BigInt(Number(round.immediateBps || 2000));
      const imm = (totalReward * immBps) / 10000n;
      const locked = totalReward - imm;

      if (!ticket.immediateClaimed) {
        payReward += imm;
      }

      const settledAt = Number(round.settledAt || 0);
      if (settledAt > 0 && defaultVestSec > 0 && !ticket.forfeited) {
        vestingPrincipalRaw = locked.toString();
        vestingStartAt = settledAt;
      }
      let unlockedNow = 0n;
      if (locked > 0n && settledAt > 0 && nowSec > settledAt) {
        const elapsed = BigInt(nowSec - settledAt);
        const dur = BigInt(Math.max(0, defaultVestSec));
        unlockedNow = (dur === 0n || elapsed >= dur) ? locked : (locked * elapsed) / dur;
      }

      const lockedClaimed = BigInt(ticket.lockedClaimedRaw ?? ticket.rewardClaimedRaw ?? '0');
      const newLockedClaimed = unlockedNow > lockedClaimed ? unlockedNow : lockedClaimed;
      if (unlockedNow > lockedClaimed) {
        payReward += unlockedNow - lockedClaimed;
      }

      const unvested = (!ticket.forfeited && locked > newLockedClaimed) ? (locked - newLockedClaimed) : 0n;
      lockedRemaining = unvested;
      if (unvested > 0n) {
        canInstantCashout = !ticket.pending;
        instantCashoutBonus = (unvested * 3000n) / 10000n;
        instantCashoutBurn = unvested - instantCashoutBonus;
      }
      if (totalReward > 0n) {
        unlockedPctBps = ticket.forfeited
          ? 10000
          : Number(((imm + (unlockedNow > lockedClaimed ? unlockedNow : lockedClaimed)) * 10000n) / totalReward);
      }
    }
  }

  const claimableTotal = payPrincipal + payReward;
  const instantCashoutTotal = claimableTotal + instantCashoutBonus;
  return {
    roundState: derived.state,
    canClaim: !ticket.pending && claimableTotal > 0n,
    canEarlyExit: false,
    earlyExitRefundRaw: '0',
    earlyExitBurnRaw: '0',
    claimablePrincipalRaw: payPrincipal.toString(),
    burnedPrincipalRaw: '0',
    claimableRewardRaw: payReward.toString(),
    claimableTotalRaw: claimableTotal.toString(),
    lockedRemainingRaw: lockedRemaining.toString(),
    canInstantCashout,
    instantCashoutTotalRaw: instantCashoutTotal.toString(),
    instantCashoutBonusRaw: instantCashoutBonus.toString(),
    instantCashoutBurnRaw: instantCashoutBurn.toString(),
    burnedLockedRaw: '0',
    vestingSeconds: defaultVestSec,
    unlockedPctBps,
    vestingStartAt,
    vestingPrincipalRaw,
  };
}

export function buildV15ConfigPayload(env = {}, protocolState = null) {
  const A9 = 1_000_000_000n;
  const proto = resolveProtocolVersion(env.A9_PROTOCOL_VERSION, 'v17');
  const maxRoundId = 4294967295;
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
    roundCount: null,
    stakeDurationSeconds: Number(env.A9_STAKE_SECONDS || 86400),
    earlyWindowSeconds: Number(env.A9_EARLY_WINDOW_SECONDS || 21600),
    observationSeconds: Number(env.A9_OBS_SECONDS || 43200),
    abortTimeoutSeconds: Number(env.A9_ABORT_TIMEOUT_SECONDS || 604800),
    candleCount: 12,
    minQualifiedCandles: 8,
    maxRewardCapMultiplier: 5,
    corridorMinBps: 13000,
    corridorMaxBps: 20000,
    unlockModel: 'LINEAR_14D',
    immediateBps: 2000,
    dailyUnlockBps: 571,
    vestingSeconds: Number(env.A9_VESTING_SECONDS || 1209600),
    failEarlyBurnBps: 500,
    failLateBurnBps: 1000,
    earlyExitBurnBps: 1500,
    instantDiscountBps: 3000,
    referralRebateBps: 800,
    roundRewardRaw: String(700_000_000n * A9),
    teamRoundRaw: String(120_000_000n * A9),
    minStakeRaw: String(100n * A9),
    token: { symbol: 'A9', decimals: 9 },
    syncedAt: ps?.syncedAt ? Number(ps.syncedAt) : null,
    contracts: {
      jettonMaster: env.A9_JETTON_MASTER_ADDRESS || null,
      roundController: env.A9_ROUND_CONTROLLER_ADDRESS || null,
      stakingEnabled: Boolean(env.A9_ROUND_CONTROLLER_ADDRESS),
      adminRenounced: typeof ps?.adminRenounced === 'boolean' ? ps.adminRenounced : null,
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
