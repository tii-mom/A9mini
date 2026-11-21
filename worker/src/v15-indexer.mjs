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
      immediateBps: Number(round.immediateBps || 0),
      lockedSlices: Number(round.lockedSlices || 0),
      unlockedSlices: Number(round.unlockedSlices || 0),
      burnedSlices: Number(round.burnedSlices || 0),
      lockedTotalRaw: String(round.lockedTotalRaw ?? '0'),
    },
    entryCount: Number(round.stakeCount || 0),
    updatedAt: nowSec * 1000,
  };
}

export function buildV15ConfigPayload(env = {}, protocolState = {}) {
  const A9 = 1_000_000_000n;
  return {
    protocolVersion: 'v15',
    network: env.A9_NETWORK || 'testnet',
    openEnded: true,
    roundCount: null, // v15: no fixed 10-round cap; runs until 7B reward pool is exhausted
    candleCount: 24,
    minQualifiedCandles: 16,
    maxRewardCapMultiplier: 15,
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
      userFeeNano: String(env.A9_PROMO_USER_FEE_NANO || '60000000'), // 0.06 TON
      userFeeTon: '0.06',
    },
    poolState: {
      currentRoundId: Number(protocolState.currentRoundId || 0),
      successCount: Number(protocolState.successCount || 0),
      poolRemainingRaw: String(protocolState.poolRemainingRaw ?? String(7_000_000_000n * A9)),
      carryRaw: String(protocolState.carryRaw ?? '0'),
      teamPoolRemainingRaw: String(protocolState.teamPoolRemainingRaw ?? String(1_200_000_000n * A9)),
      teamCarryRaw: String(protocolState.teamCarryRaw ?? '0'),
      lastSuccessAt: Number(protocolState.lastSuccessAt || 0),
      endAt: Number(protocolState.endAt || 0),
    },
  };
}
