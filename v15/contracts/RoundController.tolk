// A9 Protocol v15 — Minimalist RoundController.
//
// Core rules preserved from v14 with ~75% less code and zero pending dicts:
//   * Open-ended rounds until 7B reward pool (+ carry) is exhausted; 1.2B team pool
//   * [1.5x, 2.5x] dynamic target price corridor on every round
//   * Early-bird weights: 2.0x / 1.4x / 1.0x across staking window thirds
//   * 15x round reward soft cap with automatic carry rollover
//   * 3-tier unlock & symmetric failure slice burn (Wins 1-5: 20%+4x20%, 6-10: 40%+2x30%, 11+: 100%)
//   * Single-tx SettleRound (no 24x on-chain candles, no 6h settling delay) + AbortRound escape hatch
//   * 90d inactivity burn for unresolved locked slices + 30d linear fallback after pool exhaustion
//   * Standard unmodified TEP-74 Jetton transfers & burns; instant refund for invalid deposits

import "types"
import "ticket"
import "jetton/jetton-utils"

contract RoundController {
    author: "A9 Protocol"
    version: "15.0.0"
    description: "Minimalist A9 v15 RoundController."
    storage: Storage
    incomingMessages: ControllerMessage
}

type ControllerMessage =
    | OpenRound
    | SettleRound
    | AbortRound
    | BurnInactiveLocked
    | TransferNotification
    | TicketClaimReq
    | ReturnExcessesIgnore
    | TopUpTons

// ===========================================================================
// Helpers
// ===========================================================================
fun now64(): uint64 { return blockchain.now() as uint64; }

fun mulDiv(a: uint128, b: uint128, c: uint128): uint128 {
    return ((a as int) * (b as int) / (c as int)) as uint128;
}

fun ownWallet(cfg: ProtocolConfig): address {
    val codes = cfg.codes.load();
    return calcAddressOfJettonWallet(contract.getAddress(), cfg.jettonMaster, codes.jettonWalletCode);
}

fun emitEvent<T>(body: T) {
    createExternalLogMessage({ dest: createAddressNone(), body }).send(SEND_MODE_REGULAR);
}

fun buildJettonTransfer(queryId: uint64, amount: coins, recipient: address, excessTo: address): cell {
    return beginCell()
        .storeUint(OP_JETTON_TRANSFER, 32)
        .storeUint(queryId, 64)
        .storeCoins(amount)
        .storeAddress(recipient)
        .storeAddress(excessTo)
        .storeMaybeRef(null)
        .storeCoins(0)
        .storeUint(0, 1)
        .endCell();
}

fun buildJettonBurn(queryId: uint64, amount: coins, excessTo: address): cell {
    return beginCell()
        .storeUint(OP_JETTON_BURN, 32)
        .storeUint(queryId, 64)
        .storeCoins(amount)
        .storeAddress(excessTo)
        .storeMaybeRef(null)
        .endCell();
}

fun sendJettonFromBalance(wallet: address, body: cell) {
    createMessage({
        bounce: BounceMode.Only256BitsOfBody,
        value: VALUE_JETTON_ACTION,
        dest: wallet,
        body,
    }).send(SEND_MODE_PAY_FEES_SEPARATELY | SEND_MODE_BOUNCE_ON_ACTION_FAIL);
}

fun unwrapPayload(raw: slice): slice {
    var p = raw;
    if (p.remainingBitsCount() >= 1) {
        if (p.loadUint(1) == 1 && p.remainingRefsCount() >= 1) {
            return p.loadRef().beginParse();
        }
    }
    return p;
}

fun timingBps(rd: RoundData, now: uint64): uint128 {
    val dur = rd.stakeCloseAt - rd.stakeOpenAt;
    val elapsed = now - rd.stakeOpenAt;
    val third = dur / 3;
    if (elapsed < third) { return TIMING_BPS_FIRST; }
    if (elapsed < third * 2) { return TIMING_BPS_SECOND; }
    return TIMING_BPS_LAST;
}

fun unlockedLocked(s: Storage, timing: ProtocolTiming, meta: RoundMeta, locked: uint128, now: uint64): uint128 {
    if (meta.lockedSlices == 0 || locked == 0) { return 0; }
    val fromWins = mulDiv(locked, meta.unlockedSlices as uint128, meta.lockedSlices as uint128);
    if (s.endAt > 0 && now > s.endAt) {
        val remSlices = meta.lockedSlices - meta.unlockedSlices - meta.burnedSlices;
        if (remSlices > 0) {
            val remLocked = mulDiv(locked, remSlices as uint128, meta.lockedSlices as uint128);
            val elapsed = now - s.endAt;
            val fb = timing.fallbackUnlockSeconds as uint64;
            val fromFallback = (fb == 0 || elapsed >= fb)
                ? remLocked
                : mulDiv(remLocked, elapsed as uint128, fb as uint128);
            return fromWins + fromFallback;
        }
    }
    return fromWins;
}

// Advance up to 4 active prior locked rounds in O(1); returns total A9 to burn on failure.
fun advanceLockedRounds(mutate s: Storage, success: bool): uint128 {
    var packed = s.activeLockedRounds;
    var nextPacked: uint32 = 0;
    var nextShift: int = 0;
    var burnTotal: uint128 = 0;

    var i: int = 0;
    while (i < 4) {
        val rId = ((packed >> (i * 8)) & 0xFF) as uint8;
        if (rId > 0) {
            val found = s.rounds.get(rId);
            if (found.isFound) {
                var rd = found.loadValue();
                var meta = rd.meta.load();
                if (meta.unlockedSlices + meta.burnedSlices < meta.lockedSlices) {
                    if (success) {
                        meta.unlockedSlices += 1;
                    } else {
                        val before = mulDiv(meta.lockedTotalRaw, meta.burnedSlices as uint128, meta.lockedSlices as uint128);
                        meta.burnedSlices += 1;
                        val after = mulDiv(meta.lockedTotalRaw, meta.burnedSlices as uint128, meta.lockedSlices as uint128);
                        burnTotal += (after - before);
                    }
                    rd.meta = meta.toCell();
                    s.rounds.set(rId, rd);
                    if (meta.unlockedSlices + meta.burnedSlices < meta.lockedSlices) {
                        nextPacked = nextPacked | ((rId as uint32) << nextShift);
                        nextShift += 8;
                    }
                }
            }
        }
        i += 1;
    }
    s.activeLockedRounds = nextPacked;
    return burnTotal;
}

fun trackLockedRound(mutate s: Storage, roundId: uint8) {
    var packed = s.activeLockedRounds;
    var i: int = 0;
    while (i < 4) {
        if (((packed >> (i * 8)) & 0xFF) == 0) {
            s.activeLockedRounds = packed | ((roundId as uint32) << (i * 8));
            return;
        }
        i += 1;
    }
}

// ===========================================================================
// Message router
// ===========================================================================
fun onInternalMessage(in: InMessage) {
    if (in.body.isEmpty()) {
        return; // accept plain TON gas top-ups
    }
    val msg = lazy ControllerMessage.fromSlice(in.body);
    match (msg) {
        OpenRound => handleOpenRound(in.senderAddress, msg),
        SettleRound => handleSettleRound(in.senderAddress, msg, in.valueCoins),
        AbortRound => handleAbortRound(msg.queryId),
        BurnInactiveLocked => handleBurnInactiveLocked(msg.queryId, in.valueCoins),
        TransferNotification => handleDeposit(in.senderAddress, msg, in.valueCoins),
        TicketClaimReq => handleTicketClaim(in.senderAddress, msg, in.valueCoins),
        ReturnExcessesIgnore => {},
        TopUpTons => {},
        else => throw Errors.UnknownMessage,
    }
}

// ===========================================================================
// 1. OpenRound (roundOpener)
// ===========================================================================
fun handleOpenRound(sender: address, msg: OpenRound) {
    var s = Storage.load();
    val cfg = s.config.load();
    assert (sender == cfg.roundOpener) throw Errors.Unauthorized;
    assert (s.endAt == 0 && s.currentRoundId < MAX_ROUNDS) throw Errors.ProtocolEnded;

    if (s.currentRoundId > 0) {
        val prev = s.rounds.get(s.currentRoundId).loadValue();
        assert (prev.status != STATUS_ACTIVE) throw Errors.BadRoundStatus;
    }

    val econ = cfg.econ.load();
    val timing = cfg.timing.load();
    val nextId = s.currentRoundId + 1;

    val basePrice: uint128 = (nextId == 1 && msg.twap24hUsdE8 == 0) ? econ.p0UsdE8 : msg.twap24hUsdE8;
    assert (basePrice > 0) throw Errors.BadTargetPrice;
    val minTarget = mulDiv(basePrice, 3, 2);
    val maxTarget = mulDiv(basePrice, 5, 2);
    assert (msg.targetPriceUsdE8 >= minTarget && msg.targetPriceUsdE8 <= maxTarget) throw Errors.BadTargetPrice;

    val baseReward = s.poolRemainingRaw < econ.roundRewardRaw ? s.poolRemainingRaw : econ.roundRewardRaw;
    val budget = baseReward + s.carryRaw;
    assert (budget > 0) throw Errors.ProtocolEnded;
    s.poolRemainingRaw -= baseReward;
    s.carryRaw = 0;

    val now = now64();
    val closeAt = now + (timing.stakeDurationSeconds as uint64);
    val rd: RoundData = {
        status: STATUS_ACTIVE,
        targetPriceUsdE8: msg.targetPriceUsdE8,
        twap24hUsdE8: msg.twap24hUsdE8,
        stakeOpenAt: now,
        stakeCloseAt: closeAt,
        settledAt: 0,
        totalStakeRaw: 0,
        totalWeightRaw: 0,
        rewardBudgetRaw: budget,
        qualifiedCandles: 0,
        meta: emptyMeta().toCell(),
    };

    s.currentRoundId = nextId;
    s.rounds.set(nextId, rd);
    s.save();

    emitEvent(EvRoundOpened {
        roundId: nextId,
        twap24hUsdE8: msg.twap24hUsdE8,
        targetPriceUsdE8: msg.targetPriceUsdE8,
        rewardBudgetRaw: budget,
        stakeOpenAt: now,
        stakeCloseAt: closeAt,
    });
}

// ===========================================================================
// 2. Deposit (standard TEP-74 transfer_notification from own JettonWallet)
// ===========================================================================
fun refundInvalidDeposit(wallet: address, initiator: address?, amount: coins, inboundTon: coins, queryId: uint64) {
    if (initiator == null || initiator!.getWorkchain() != BASECHAIN || inboundTon < MIN_REFUND_VALUE) {
        return;
    }
    reserveToncoinsOnBalance(contract.getOriginalBalance() - inboundTon, RESERVE_MODE_AT_MOST);
    emitEvent(EvDepositRefunded { recipient: initiator!, amountRaw: amount as uint128 });
    createMessage({
        bounce: BounceMode.NoBounce,
        value: 0,
        dest: wallet,
        body: buildJettonTransfer(queryId, amount, initiator!, initiator!),
    }).send(SEND_MODE_CARRY_ALL_BALANCE | SEND_MODE_IGNORE_ERRORS);
}

fun handleDeposit(sender: address, msg: TransferNotification, inboundTon: coins) {
    var s = Storage.load();
    val cfg = s.config.load();
    val wallet = ownWallet(cfg);
    assert (sender == wallet) throw Errors.NotJettonWallet;

    val amount = msg.jettonAmount as uint128;
    if (amount == 0) { return; }

    var p = unwrapPayload(msg.forwardPayload);
    if (p.remainingBitsCount() < 40 || (p.loadUint(32) as uint32) != OP_STAKE_DEPOSIT) {
        refundInvalidDeposit(wallet, msg.transferInitiator, msg.jettonAmount, inboundTon, msg.queryId);
        return;
    }
    val roundId = p.loadUint(8) as uint8;
    var owner: address? = msg.transferInitiator;
    var payloadValid = true;
    if (p.remainingBitsCount() >= 2) {
        val addrTag = p.preloadUint(2);
        if (addrTag == 2 && p.remainingBitsCount() >= 267) {
            owner = p.loadAddress();
        } else if (addrTag != 0) {
            payloadValid = false;
        }
    }

    val econ = cfg.econ.load();
    val now = now64();
    val validOwner = payloadValid && owner != null && owner!.getWorkchain() == BASECHAIN;
    var accepted = false;

    if (validOwner && s.currentRoundId > 0 && roundId == s.currentRoundId && amount >= econ.minStakeRaw && inboundTon >= MIN_DEPOSIT_VALUE) {
        var rd = s.rounds.get(roundId).loadValue();
        if (rd.status == STATUS_ACTIVE && now >= rd.stakeOpenAt && now < rd.stakeCloseAt) {
            val weight = mulDiv(amount, timingBps(rd, now), BPS);
            var meta = rd.meta.load();
            rd.totalStakeRaw += amount;
            rd.totalWeightRaw += weight;
            meta.stakeCount += 1;
            rd.meta = meta.toCell();
            s.rounds.set(roundId, rd);
            s.save();

            val codes = cfg.codes.load();
            reserveToncoinsOnBalance(contract.getOriginalBalance() - inboundTon, RESERVE_MODE_AT_MOST);
            emitEvent(EvDepositAccepted { roundId, owner: owner!, amountRaw: amount, weightRaw: weight });
            createMessage({
                bounce: BounceMode.Only256BitsOfBody,
                value: 0,
                dest: calcDeployedTicket(contract.getAddress(), owner!, roundId, codes.ticketCode),
                body: TicketAddStake { queryId: msg.queryId, amountRaw: amount, weightRaw: weight },
            }).send(SEND_MODE_CARRY_ALL_BALANCE | SEND_MODE_BOUNCE_ON_ACTION_FAIL);
            accepted = true;
        }
    }

    if (!accepted) {
        refundInvalidDeposit(wallet, msg.transferInitiator, msg.jettonAmount, inboundTon, msg.queryId);
    }
}

// ===========================================================================
// 3. SettleRound (single-tx settlement by keeper or roundOpener, zero delay)
// ===========================================================================
fun handleSettleRound(sender: address, msg: SettleRound, inboundTon: coins) {
    assert (inboundTon >= MIN_SETTLE_VALUE) throw Errors.NotEnoughValue;
    var s = Storage.load();
    val cfg = s.config.load();
    assert (sender == cfg.keeper || sender == cfg.roundOpener) throw Errors.Unauthorized;
    assert (s.currentRoundId > 0 && msg.roundId == s.currentRoundId) throw Errors.BadRoundId;

    var rd = s.rounds.get(msg.roundId).loadValue();
    assert (rd.status == STATUS_ACTIVE) throw Errors.BadRoundStatus;

    val timing = cfg.timing.load();
    val now = now64();
    assert (now >= rd.stakeCloseAt + (timing.observationSeconds as uint64)) throw Errors.TooEarly;
    assert (msg.qualifiedCandles <= timing.candleCount) throw Errors.BadInput;

    val econ = cfg.econ.load();
    val teamBase = s.teamPoolRemainingRaw < econ.teamRoundRaw ? s.teamPoolRemainingRaw : econ.teamRoundRaw;
    s.teamPoolRemainingRaw -= teamBase;

    var meta = rd.meta.load();
    meta.candleHash = msg.candleHash;
    rd.qualifiedCandles = msg.qualifiedCandles;
    rd.settledAt = now;

    var teamReleased: uint128 = 0;
    var totalBurn: uint128 = 0;

    if (msg.qualifiedCandles >= timing.minQualifiedCandles) {
        // SUCCEEDED
        val capRaw: int = (rd.totalStakeRaw as int) * (MAX_REWARD_MULTIPLIER as int);
        val distributable: uint128 = (rd.rewardBudgetRaw as int) < capRaw ? rd.rewardBudgetRaw : (capRaw as uint128);
        s.carryRaw += (rd.rewardBudgetRaw - distributable);

        val teamBudget = teamBase + s.teamCarryRaw;
        teamReleased = rd.rewardBudgetRaw > 0 ? mulDiv(teamBudget, distributable, rd.rewardBudgetRaw) : (0 as uint128);
        s.teamCarryRaw = teamBudget - teamReleased;

        advanceLockedRounds(mutate s, true);
        s.successCount += 1;
        s.lastSuccessAt = now;

        val immBps: uint16 = s.successCount <= 5 ? (2000 as uint16) : (s.successCount <= 10 ? (4000 as uint16) : (10000 as uint16));
        val slices: uint8 = s.successCount <= 5 ? (4 as uint8) : (s.successCount <= 10 ? (2 as uint8) : (0 as uint8));
        val immTotal = mulDiv(distributable, immBps as uint128, BPS);
        val lockedTotal = distributable - immTotal;

        rd.status = STATUS_SUCCEEDED;
        rd.rewardBudgetRaw = distributable;
        meta.immediateBps = immBps;
        meta.lockedSlices = slices;
        meta.lockedTotalRaw = lockedTotal;
        rd.meta = meta.toCell();
        s.rounds.set(msg.roundId, rd);

        if (slices > 0 && lockedTotal > 0) {
            trackLockedRound(mutate s, msg.roundId);
        }
    } else {
        // FAILED: burn 100% principal + half budget + this round's team quota + 1 slice of each active prior round
        val rewardBurn = rd.rewardBudgetRaw / 2;
        s.carryRaw += (rd.rewardBudgetRaw - rewardBurn);
        val sliceBurn = advanceLockedRounds(mutate s, false);
        totalBurn = rewardBurn + rd.totalStakeRaw + teamBase + sliceBurn;

        rd.status = STATUS_FAILED;
        rd.meta = meta.toCell();
        s.rounds.set(msg.roundId, rd);
    }

    // Pool exhaustion finality: start 30d linear fallback & burn remaining team pools
    if (s.poolRemainingRaw == 0 && s.carryRaw == 0) {
        s.endAt = now;
        totalBurn += s.teamPoolRemainingRaw + s.teamCarryRaw;
        s.teamPoolRemainingRaw = 0;
        s.teamCarryRaw = 0;
    }

    s.save();

    val wallet = ownWallet(cfg);
    if (teamReleased > 0) {
        sendJettonFromBalance(wallet, buildJettonTransfer(msg.queryId, teamReleased as coins, econ.teamWallet, contract.getAddress()));
    }
    if (totalBurn > 0) {
        sendJettonFromBalance(wallet, buildJettonBurn(msg.queryId, totalBurn as coins, contract.getAddress()));
    }

    emitEvent(EvRoundSettled {
        roundId: msg.roundId,
        status: rd.status,
        qualifiedCandles: rd.qualifiedCandles,
        candleHash: msg.candleHash,
        totalStakeRaw: rd.totalStakeRaw,
        rewardBudgetRaw: rd.rewardBudgetRaw,
        teamReleasedRaw: teamReleased,
        burnedRaw: totalBurn,
        carryAfterRaw: s.carryRaw,
    });
}

// ===========================================================================
// 4. AbortRound (permissionless escape hatch if keeper goes offline)
// ===========================================================================
fun handleAbortRound(queryId: uint64) {
    var s = Storage.load();
    assert (s.currentRoundId > 0) throw Errors.BadRoundId;
    var rd = s.rounds.get(s.currentRoundId).loadValue();
    assert (rd.status == STATUS_ACTIVE) throw Errors.BadRoundStatus;

    val timing = s.config.load().timing.load();
    val now = now64();
    val deadline = rd.stakeCloseAt + (timing.observationSeconds as uint64) + (timing.abortTimeoutSeconds as uint64);
    assert (now >= deadline) throw Errors.TooEarly;

    rd.status = STATUS_ABORTED;
    rd.settledAt = now;
    s.carryRaw += rd.rewardBudgetRaw;
    s.rounds.set(s.currentRoundId, rd);
    s.save();

    emitEvent(EvRoundSettled {
        roundId: s.currentRoundId,
        status: STATUS_ABORTED,
        qualifiedCandles: 0,
        candleHash: 0 as uint256,
        totalStakeRaw: rd.totalStakeRaw,
        rewardBudgetRaw: rd.rewardBudgetRaw,
        teamReleasedRaw: 0,
        burnedRaw: 0,
        carryAfterRaw: s.carryRaw,
    });
}

// ===========================================================================
// 5. BurnInactiveLocked (permissionless 90d inactivity burn)
// ===========================================================================
fun handleBurnInactiveLocked(queryId: uint64, inboundTon: coins) {
    assert (inboundTon >= MIN_CLAIM_VALUE) throw Errors.NotEnoughValue;
    var s = Storage.load();
    val cfg = s.config.load();
    val timing = cfg.timing.load();
    val now = now64();

    assert (s.endAt == 0 && s.lastSuccessAt > 0) throw Errors.TooEarly;
    assert (now >= s.lastSuccessAt + (timing.inactivityBurnSeconds as uint64)) throw Errors.TooEarly;

    var packed = s.activeLockedRounds;
    var totalBurn: uint128 = 0;
    var i: int = 0;
    while (i < 4) {
        val rId = ((packed >> (i * 8)) & 0xFF) as uint8;
        if (rId > 0) {
            val found = s.rounds.get(rId);
            if (found.isFound) {
                var rd = found.loadValue();
                var meta = rd.meta.load();
                val rem = meta.lockedSlices - meta.unlockedSlices - meta.burnedSlices;
                if (rem > 0) {
                    val before = mulDiv(meta.lockedTotalRaw, meta.burnedSlices as uint128, meta.lockedSlices as uint128);
                    meta.burnedSlices += rem;
                    val after = mulDiv(meta.lockedTotalRaw, meta.burnedSlices as uint128, meta.lockedSlices as uint128);
                    totalBurn += (after - before);
                    rd.meta = meta.toCell();
                    s.rounds.set(rId, rd);
                }
            }
        }
        i += 1;
    }
    assert (totalBurn > 0) throw Errors.NothingToBurn;

    s.activeLockedRounds = 0;
    s.save();

    sendJettonFromBalance(ownWallet(cfg), buildJettonBurn(queryId, totalBurn as coins, contract.getAddress()));
    emitEvent(EvInactiveLockedBurned { burnedRaw: totalBurn, at: now });
}

// ===========================================================================
// 6. TicketClaimReq (stateless O(1) claim — zero pending dicts!)
// ===========================================================================
fun handleTicketClaim(sender: address, msg: TicketClaimReq, inboundTon: coins) {
    assert (inboundTon >= MIN_RC_CLAIM_VALUE) throw Errors.NotEnoughValue;
    val s = Storage.load();
    val cfg = s.config.load();
    val codes = cfg.codes.load();
    assert (sender == calcTicketAddress(contract.getAddress(), msg.owner, msg.roundId, codes.ticketCode)) throw Errors.NotTicket;

    val found = s.rounds.get(msg.roundId);
    assert (found.isFound) throw Errors.BadRoundId;
    val rd = found.loadValue();
    assert (rd.status == STATUS_SUCCEEDED || rd.status == STATUS_ABORTED) throw Errors.NothingToClaim;

    var payPrincipal: uint128 = 0;
    var newPrincipalDone = msg.principalDone;
    if (!msg.principalDone) {
        payPrincipal = msg.amountRaw;
        newPrincipalDone = true;
    }

    var payReward: uint128 = 0;
    var newImmClaimed = msg.immediateClaimed;
    var newLockedClaimed = msg.lockedClaimedRaw;

    if (rd.status == STATUS_SUCCEEDED && rd.totalWeightRaw > 0 && msg.weightRaw > 0) {
        val meta = rd.meta.load();
        val totalReward = mulDiv(rd.rewardBudgetRaw, msg.weightRaw, rd.totalWeightRaw);
        val imm = mulDiv(totalReward, meta.immediateBps as uint128, BPS);
        val locked = totalReward - imm;

        if (!msg.immediateClaimed) {
            payReward += imm;
            newImmClaimed = true;
        }
        val unlockedNow = unlockedLocked(s, cfg.timing.load(), meta, locked, now64());
        if (unlockedNow > msg.lockedClaimedRaw) {
            payReward += (unlockedNow - msg.lockedClaimedRaw);
            newLockedClaimed = unlockedNow;
        }
    }

    val totalPay = payPrincipal + payReward;
    assert (totalPay > 0) throw Errors.NothingToClaim;

    reserveToncoinsOnBalance(contract.getOriginalBalance() - inboundTon, RESERVE_MODE_AT_MOST);

    emitEvent(EvClaimed {
        owner: msg.owner,
        roundId: msg.roundId,
        principalRaw: payPrincipal,
        rewardRaw: payReward,
    });

    createMessage({
        bounce: BounceMode.NoBounce,
        value: VALUE_TICKET_MSG,
        dest: sender,
        body: TicketConfirm {
            queryId: msg.queryId,
            principalDone: newPrincipalDone,
            immediateClaimed: newImmClaimed,
            lockedClaimedRaw: newLockedClaimed,
        },
    }).send(SEND_MODE_PAY_FEES_SEPARATELY | SEND_MODE_BOUNCE_ON_ACTION_FAIL);

    createMessage({
        bounce: BounceMode.Only256BitsOfBody,
        value: 0,
        dest: ownWallet(cfg),
        body: buildJettonTransfer(msg.queryId, totalPay as coins, msg.owner, msg.owner),
    }).send(SEND_MODE_CARRY_ALL_BALANCE | SEND_MODE_BOUNCE_ON_ACTION_FAIL);
}

// ===========================================================================
// Get methods
// ===========================================================================
get fun get_protocol_state(): ProtocolStateView {
    val s = Storage.load();
    return {
        currentRoundId: s.currentRoundId,
        successCount: s.successCount,
        poolRemainingRaw: s.poolRemainingRaw,
        carryRaw: s.carryRaw,
        teamPoolRemainingRaw: s.teamPoolRemainingRaw,
        teamCarryRaw: s.teamCarryRaw,
        lastSuccessAt: s.lastSuccessAt,
        endAt: s.endAt,
        activeLockedRounds: s.activeLockedRounds,
    };
}

get fun get_round(roundId: uint8): RoundView {
    val s = Storage.load();
    val found = s.rounds.get(roundId);
    if (!found.isFound) {
        return {
            status: STATUS_UNOPENED,
            targetPriceUsdE8: 0, twap24hUsdE8: 0, stakeOpenAt: 0, stakeCloseAt: 0, settledAt: 0,
            totalStakeRaw: 0, totalWeightRaw: 0, rewardBudgetRaw: 0, qualifiedCandles: 0,
            candleHash: 0 as uint256, immediateBps: 0, lockedSlices: 0, unlockedSlices: 0,
            burnedSlices: 0, lockedTotalRaw: 0, stakeCount: 0,
        };
    }
    val rd = found.loadValue();
    val m = rd.meta.load();
    return {
        status: rd.status,
        targetPriceUsdE8: rd.targetPriceUsdE8,
        twap24hUsdE8: rd.twap24hUsdE8,
        stakeOpenAt: rd.stakeOpenAt,
        stakeCloseAt: rd.stakeCloseAt,
        settledAt: rd.settledAt,
        totalStakeRaw: rd.totalStakeRaw,
        totalWeightRaw: rd.totalWeightRaw,
        rewardBudgetRaw: rd.rewardBudgetRaw,
        qualifiedCandles: rd.qualifiedCandles,
        candleHash: m.candleHash,
        immediateBps: m.immediateBps,
        lockedSlices: m.lockedSlices,
        unlockedSlices: m.unlockedSlices,
        burnedSlices: m.burnedSlices,
        lockedTotalRaw: m.lockedTotalRaw,
        stakeCount: m.stakeCount,
    };
}

get fun get_reward_preview(roundId: uint8, weightRaw: uint128): RewardPreview {
    val s = Storage.load();
    val found = s.rounds.get(roundId);
    if (!found.isFound || weightRaw == 0) {
        return { totalRewardRaw: 0, immediateRaw: 0, lockedRaw: 0, unlockedLockedRaw: 0, burnedLockedRaw: 0 };
    }
    val rd = found.loadValue();
    if (rd.status != STATUS_SUCCEEDED || rd.totalWeightRaw == 0) {
        return { totalRewardRaw: 0, immediateRaw: 0, lockedRaw: 0, unlockedLockedRaw: 0, burnedLockedRaw: 0 };
    }
    val meta = rd.meta.load();
    val total = mulDiv(rd.rewardBudgetRaw, weightRaw, rd.totalWeightRaw);
    val imm = mulDiv(total, meta.immediateBps as uint128, BPS);
    val locked = total - imm;
    val unlocked = unlockedLocked(s, s.config.load().timing.load(), meta, locked, now64());
    val burned: uint128 = meta.lockedSlices > 0 ? mulDiv(locked, meta.burnedSlices as uint128, meta.lockedSlices as uint128) : (0 as uint128);
    return { totalRewardRaw: total, immediateRaw: imm, lockedRaw: locked, unlockedLockedRaw: unlocked, burnedLockedRaw: burned };
}

get fun get_jetton_wallet_address(): address {
    return ownWallet(Storage.load().config.load());
}

get fun get_ticket_address(owner: address, roundId: uint8): address {
    val codes = Storage.load().config.load().codes.load();
    return calcTicketAddress(contract.getAddress(), owner, roundId, codes.ticketCode);
}
