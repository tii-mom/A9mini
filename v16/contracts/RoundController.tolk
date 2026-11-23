// A9 Protocol v16 — Minimalist RoundController.
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

import "@stdlib/gas-payments"
import "types"
import "ticket"
import "jetton/jetton-utils"

contract RoundController {
    author: "A9 Protocol"
    version: "16.0.0"
    description: "Minimalist A9 v16 RoundController with W3 bounce recovery and escrowed low-gas refunds."
    storage: Storage
    incomingMessages: ControllerMessage
}

type ControllerMessage =
    | OpenRound
    | SettleRound
    | AbortRound
    | BurnInactiveLocked
    | ClaimFailedRefund
    | TransferNotification
    | TicketClaimReq
    | TicketStakeAck
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
    var nextPacked: uint128 = 0;
    var nextShift: int = 0;
    var burnTotal: uint128 = 0;

    var i: int = 0;
    while (i < 4) {
        val rId = ((packed >> (i * 32)) & 0xFFFFFFFF) as uint32;
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
                        nextPacked = nextPacked | ((rId as uint128) << nextShift);
                        nextShift += 32;
                    }
                }
            }
        }
        i += 1;
    }
    s.activeLockedRounds = nextPacked;
    return burnTotal;
}

fun trackLockedRound(mutate s: Storage, roundId: uint32) {
    var packed = s.activeLockedRounds;
    var i: int = 0;
    while (i < 4) {
        if (((packed >> (i * 32)) & 0xFFFFFFFF) == 0) {
            s.activeLockedRounds = packed | ((roundId as uint128) << (i * 32));
            return;
        }
        i += 1;
    }
}

// ===========================================================================
// W3 Recovery Helpers (storage-safe reserve + O(1) lazy GC + escrowed pull refunds)
// ===========================================================================
fun reserveRcBalance(inboundTon: coins) {
    // 补齐历史欠缴存储费（getStorageDuePayment）并保底 RC_MIN_BALANCE，彻底避免负值 RAWRESERVE 崩溃
    val orig: int = contract.getOriginalBalance() as int;
    val inVal: int = inboundTon as int;
    val due: int = contract.getStorageDuePayment() as int;
    val target: int = orig - inVal + due;
    val minBal: int = RC_MIN_BALANCE as int;
    val safeReserve: coins = (target > minBal ? target : minBal) as coins;
    reserveToncoinsOnBalance(safeReserve, RESERVE_MODE_AT_MOST);
}

fun gcStalePending(mutate rec: RecoveryState, now: uint64) {
    // opId 单调递增，字典键最小项即为最老项；每次写操作 O(1) 清理最多 3 条超龄（>300s）瞬时记录
    var i: int = 0;
    var moreClaims = true;
    while (i < 3 && moreClaims) {
        val firstClaim = rec.pendingClaims.findFirst();
        if (firstClaim.isFound) {
            val pc = firstClaim.loadValue().load();
            if (now >= pc.createdAt + PENDING_GC_TTL) {
                rec.pendingClaims.delete(firstClaim.getKey());
            } else {
                moreClaims = false;
            }
        } else {
            moreClaims = false;
        }
        i += 1;
    }
    var j: int = 0;
    var moreStakes = true;
    while (j < 3 && moreStakes) {
        val firstStake = rec.pendingStakes.findFirst();
        if (firstStake.isFound) {
            val ps = firstStake.loadValue().load();
            if (now >= ps.createdAt + PENDING_GC_TTL) {
                rec.pendingStakes.delete(firstStake.getKey());
            } else {
                moreStakes = false;
            }
        } else {
            moreStakes = false;
        }
        j += 1;
    }
}

fun nextPendingOpId(mutate rec: RecoveryState, now: uint64): uint64 {
    gcStalePending(mutate rec, now);
    rec.nextOpId += 1;
    return PENDING_OP_FLAG | (rec.nextOpId & NON_PENDING_QUERY_MASK);
}

fun escrowRefund(mutate rec: RecoveryState, recipient: address, amountRaw: uint128) {
    if (amountRaw == 0) { return; }
    val prev = rec.failedRefunds.get(recipient);
    val nextAmt: uint128 = prev.isFound ? ((prev.loadValue() + amountRaw) as uint128) : amountRaw;
    rec.failedRefunds.set(recipient, nextAmt);
    emitEvent(EvDepositRefundEscrowed { recipient, amountRaw });
}

fun sendExcessTo(dest: address, queryId: uint64) {
    createMessage({
        bounce: BounceMode.NoBounce,
        value: 0,
        dest,
        body: ReturnExcessesIgnore { queryId },
    }).send(SEND_MODE_CARRY_ALL_BALANCE | SEND_MODE_IGNORE_ERRORS);
}

// ===========================================================================
// Bounce handler (W3: atomic rollback for TicketAddStake & own JettonWallet payouts)
// ===========================================================================
fun onBouncedMessage(in: InMessageBounced) {
    in.bouncedBody.skipBouncedPrefix();
    if (in.bouncedBody.remainingBitsCount() < 96) {
        return;
    }
    val op = in.bouncedBody.loadUint(32) as uint32;
    val opId = in.bouncedBody.loadUint(64) as uint64;

    if (op == OP_TICKET_ADD_STAKE) {
        var s = Storage.load();
        val cfg = s.config.load();
        val codes = cfg.codes.load();
        var rec = s.recovery.load();
        val found = rec.pendingStakes.get(opId);
        if (!found.isFound) { return; }
        val ps = found.loadValue().load();
        if (in.senderAddress != calcTicketAddress(contract.getAddress(), ps.owner, ps.roundId, codes.ticketCode)) {
            return;
        }
        rec.pendingStakes.delete(opId);

        // 仅当轮次仍为 ACTIVE（回滚账本）或 ABORTED（本金未烧）时允许退还；
        // 若轮次已 FAILED，本金已按账本烧毁，严禁再次退款导致资不抵债！
        var canRefund = false;
        val rFound = s.rounds.get(ps.roundId);
        if (rFound.isFound) {
            var rd = rFound.loadValue();
            if (rd.status == STATUS_ACTIVE) {
                var meta = rd.meta.load();
                rd.totalStakeRaw = rd.totalStakeRaw >= ps.amountRaw ? (rd.totalStakeRaw - ps.amountRaw) : (0 as uint128);
                rd.totalWeightRaw = rd.totalWeightRaw >= ps.weightRaw ? (rd.totalWeightRaw - ps.weightRaw) : (0 as uint128);
                meta.stakeCount = meta.stakeCount > 0 ? (meta.stakeCount - 1) : (0 as uint32);
                rd.meta = meta.toCell();
                s.rounds.set(ps.roundId, rd);
                canRefund = true;
            } else if (rd.status == STATUS_ABORTED) {
                canRefund = true;
            }
        }

        emitEvent(EvStakeBounced {
            roundId: ps.roundId,
            owner: ps.owner,
            recipient: ps.refundTo,
            amountRaw: ps.amountRaw,
        });
        if (canRefund) {
            refundOrEscrow(mutate s, mutate rec, ownWallet(cfg), ps.refundTo, ps.amountRaw as coins, in.valueCoins, ps.userQueryId);
        } else {
            s.recovery = rec.toCell();
            s.save();
        }
        return;
    }

    if (op == OP_JETTON_TRANSFER) {
        var s = Storage.load();
        val cfg = s.config.load();
        if (in.senderAddress != ownWallet(cfg)) {
            return;
        }
        var rec = s.recovery.load();
        val found = rec.pendingClaims.get(opId);
        if (!found.isFound) { return; }
        val pc = found.loadValue().load();
        rec.pendingClaims.delete(opId);

        if (pc.kind == PENDING_CLAIM_KIND_TICKET) {
            // 仅由可信自身 JettonWallet bounce 触发：
            // 正常 bounce（in.valueCoins >= 0.035 TON）完整保留 RC 原有全部余额（preTx）；
            // 极低 Gas bounce 时最多从 RC 储备补贴至 0.035 TON 完成回滚（避免 Exit 37 丢回滚），
            // 同时严守 RC_MIN_BALANCE 下限且绝不将 RC 额外储备金打包退给用户。
            val codes = cfg.codes.load();
            s.recovery = rec.toCell();
            s.save();
            emitEvent(EvClaimBounced {
                owner: pc.owner,
                roundId: pc.roundId,
                amountRaw: pc.amountRaw,
            });
            val orig: int = contract.getOriginalBalance() as int;
            val preTx: int = orig - (in.valueCoins as int) + (contract.getStorageDuePayment() as int);
            val maxLeave: int = orig - (VALUE_TICKET_MSG as int) - (ton("0.01") as int);
            val desired: int = preTx < maxLeave ? preTx : maxLeave;
            val minBal: int = RC_MIN_BALANCE as int;
            val safeReserve: coins = (desired > minBal ? desired : minBal) as coins;
            reserveToncoinsOnBalance(safeReserve, RESERVE_MODE_AT_MOST);
            createMessage({
                bounce: BounceMode.NoBounce,
                value: 0,
                dest: calcTicketAddress(contract.getAddress(), pc.owner, pc.roundId, codes.ticketCode),
                body: TicketClaimRollback {
                    queryId: pc.userQueryId,
                    revertPrincipal: pc.revertPrincipal,
                    revertImm: pc.revertImm,
                    revertLockedRaw: pc.revertLockedRaw,
                },
            }).send(SEND_MODE_CARRY_ALL_BALANCE);
            return;
        }

        if (pc.kind == PENDING_CLAIM_KIND_INSTANT_REFUND || pc.kind == PENDING_CLAIM_KIND_PULL_REFUND) {
            // 实时退款或自助退款在 ownWallet 侧失败：全额还原至 failedRefunds 托管账本，永不吞币
            escrowRefund(mutate rec, pc.owner, pc.amountRaw);
            s.recovery = rec.toCell();
            s.save();
            reserveRcBalance(in.valueCoins);
            sendExcessTo(pc.owner, pc.userQueryId);
            return;
        }
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
        ClaimFailedRefund => handleClaimFailedRefund(in.senderAddress, msg, in.valueCoins),
        TransferNotification => handleDeposit(in.senderAddress, msg, in.valueCoins),
        TicketClaimReq => handleTicketClaim(in.senderAddress, msg, in.valueCoins),
        TicketStakeAck => handleTicketStakeAck(in.senderAddress, msg),
        ReturnExcessesIgnore => {}, // 不再将第三方可触发的 ReturnExcessesBack 作为状态机回调
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
fun refundOrEscrow(
    mutate s: Storage,
    mutate rec: RecoveryState,
    wallet: address,
    initiator: address?,
    amount: coins,
    inboundTon: coins,
    queryId: uint64,
) {
    val amtRaw = amount as uint128;
    if (initiator == null || initiator!.getWorkchain() != BASECHAIN || amtRaw == 0) {
        s.recovery = rec.toCell();
        s.save();
        return;
    }
    // P1-1 防低 Gas 粉尘抽干与字典膨胀攻击：不足 0.015 GRAM 且低于 1 A9 的垃圾转账直接忽略
    if (inboundTon < MIN_ESCROW_GAS && amtRaw < MIN_ESCROW_AMOUNT) {
        s.recovery = rec.toCell();
        s.save();
        return;
    }
    if (inboundTon < MIN_REFUND_VALUE) {
        // W3: 低 Gas 无效入金不吞币也不消耗协议 GRAM，转为拉取式托管退款供用户自付 Gas 提取
        escrowRefund(mutate rec, initiator!, amtRaw);
        s.recovery = rec.toCell();
        s.save();
        return;
    }
    val now = now64();
    val opId = nextPendingOpId(mutate rec, now);
    rec.pendingClaims.set(opId, PendingClaim {
        kind: PENDING_CLAIM_KIND_INSTANT_REFUND,
        owner: initiator!,
        roundId: 0 as uint32,
        userQueryId: queryId,
        revertPrincipal: false,
        revertImm: false,
        revertLockedRaw: 0,
        amountRaw: amtRaw,
        createdAt: now,
    }.toCell());
    s.recovery = rec.toCell();
    s.save();

    reserveRcBalance(inboundTon);
    emitEvent(EvDepositRefunded { recipient: initiator!, amountRaw: amtRaw });
    createMessage({
        bounce: BounceMode.Only256BitsOfBody,
        value: 0,
        dest: wallet,
        body: buildJettonTransfer(opId, amount, initiator!, initiator!),
    }).send(SEND_MODE_CARRY_ALL_BALANCE | SEND_MODE_BOUNCE_ON_ACTION_FAIL);
}

fun handleDeposit(sender: address, msg: TransferNotification, inboundTon: coins) {
    var s = Storage.load();
    val cfg = s.config.load();
    val wallet = ownWallet(cfg);
    assert (sender == wallet) throw Errors.NotJettonWallet;

    val amount = msg.jettonAmount as uint128;
    if (amount == 0) { return; }

    var rec = s.recovery.load();
    var p = unwrapPayload(msg.forwardPayload);
    if (p.remainingBitsCount() < 64 || (p.loadUint(32) as uint32) != OP_STAKE_DEPOSIT) {
        refundOrEscrow(mutate s, mutate rec, wallet, msg.transferInitiator, msg.jettonAmount, inboundTon, msg.queryId);
        return;
    }
    val roundId = p.loadUint(32) as uint32;
    var owner: address? = msg.transferInitiator;
    var payloadValid = true;
    if (p.remainingBitsCount() >= 2) {
        val addrTag = p.preloadUint(2);
        // P1-2: 严格校验 addr_std 且 anycast == 0 (0b100 == 4)，防止畸形 anycast 地址导致 loadAddress 异常吞币
        if (addrTag == 2) {
            if (p.remainingBitsCount() >= 267 && p.preloadUint(3) == 4) {
                owner = p.loadAddress();
            } else {
                payloadValid = false;
            }
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

            val refundTo: address = (msg.transferInitiator != null && msg.transferInitiator!.getWorkchain() == BASECHAIN)
                ? msg.transferInitiator!
                : owner!;
            val opId = nextPendingOpId(mutate rec, now);
            rec.pendingStakes.set(opId, PendingStake {
                roundId,
                owner: owner!,
                refundTo,
                amountRaw: amount,
                weightRaw: weight,
                userQueryId: msg.queryId,
                createdAt: now,
            }.toCell());
            s.recovery = rec.toCell();
            s.save();

            val codes = cfg.codes.load();
            reserveRcBalance(inboundTon);
            emitEvent(EvDepositAccepted { roundId, owner: owner!, amountRaw: amount, weightRaw: weight });
            createMessage({
                bounce: BounceMode.Only256BitsOfBody,
                value: 0,
                dest: calcDeployedTicket(contract.getAddress(), owner!, roundId, codes.ticketCode),
                body: TicketAddStake { opId, userQueryId: msg.queryId, amountRaw: amount, weightRaw: weight },
            }).send(SEND_MODE_CARRY_ALL_BALANCE | SEND_MODE_BOUNCE_ON_ACTION_FAIL);
            accepted = true;
        }
    }

    if (!accepted) {
        refundOrEscrow(mutate s, mutate rec, wallet, msg.transferInitiator, msg.jettonAmount, inboundTon, msg.queryId);
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

    // P0-4 防护：先 O(1) 清理超龄僵尸 pendingStakes；再检查 opId 最大的最新记录（findLast），
    // 仅当最新一条属于当前轮且仍在 300s 活跃期内才拒绝抢跑结算，既杜绝 >=4 条僵尸记录死锁，又防旧轮残留绕过。
    var rec = s.recovery.load();
    gcStalePending(mutate rec, now);
    val lastPendingStake = rec.pendingStakes.findLast();
    if (lastPendingStake.isFound) {
        val ps = lastPendingStake.loadValue().load();
        assert (!(ps.roundId == msg.roundId && now < ps.createdAt + PENDING_GC_TTL)) throw Errors.TooEarly;
    }
    s.recovery = rec.toCell();

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
    val safeQueryId = msg.queryId & NON_PENDING_QUERY_MASK;
    if (teamReleased > 0) {
        sendJettonFromBalance(wallet, buildJettonTransfer(safeQueryId, teamReleased as coins, econ.teamWallet, contract.getAddress()));
    }
    if (totalBurn > 0) {
        sendJettonFromBalance(wallet, buildJettonBurn(safeQueryId, totalBurn as coins, contract.getAddress()));
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
        val rId = ((packed >> (i * 32)) & 0xFFFFFFFF) as uint32;
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

    sendJettonFromBalance(ownWallet(cfg), buildJettonBurn(queryId & NON_PENDING_QUERY_MASK, totalBurn as coins, contract.getAddress()));
    emitEvent(EvInactiveLockedBurned { burnedRaw: totalBurn, at: now });
}

// ===========================================================================
// 6. TicketClaimReq (W3: 3-hop direct payout + trusted ownWallet bounce delta rollback)
// ===========================================================================
fun handleTicketClaim(sender: address, msg: TicketClaimReq, inboundTon: coins) {
    assert (inboundTon >= MIN_RC_CLAIM_VALUE) throw Errors.NotEnoughValue;
    var s = Storage.load();
    val cfg = s.config.load();
    val codes = cfg.codes.load();
    assert (sender == calcTicketAddress(contract.getAddress(), msg.owner, msg.roundId, codes.ticketCode)) throw Errors.NotTicket;

    val found = s.rounds.get(msg.roundId);
    assert (found.isFound) throw Errors.BadRoundId;
    val rd = found.loadValue();
    assert (rd.status == STATUS_SUCCEEDED || rd.status == STATUS_ABORTED) throw Errors.NothingToClaim;

    var payPrincipal: uint128 = 0;
    if (!msg.principalDone) {
        payPrincipal = msg.amountRaw;
    }

    var payImm: uint128 = 0;
    var payLocked: uint128 = 0;
    val now = now64();

    if (rd.status == STATUS_SUCCEEDED && rd.totalWeightRaw > 0 && msg.weightRaw > 0) {
        val meta = rd.meta.load();
        val totalReward = mulDiv(rd.rewardBudgetRaw, msg.weightRaw, rd.totalWeightRaw);
        val imm = mulDiv(totalReward, meta.immediateBps as uint128, BPS);
        val locked = totalReward - imm;

        if (!msg.immediateClaimed) {
            payImm = imm;
        }
        val unlockedNow = unlockedLocked(s, cfg.timing.load(), meta, locked, now);
        if (unlockedNow > msg.lockedClaimedRaw) {
            payLocked = unlockedNow - msg.lockedClaimedRaw;
        }
    }

    val payReward = payImm + payLocked;
    val totalPay = payPrincipal + payReward;
    assert (totalPay > 0) throw Errors.NothingToClaim;

    // P0-1/P0-3 根治架构：
    // 不再依赖第三方可伪造的 ReturnExcessesBack 回调；直发 TicketConfirm + 标准 TEP-74 AskToTransfer（excessTo=owner），
    // 并登记精确增量快照至 pendingClaims（O(1) 惰性 GC）；若 ownWallet 发生 bounce 则精准发 TicketClaimRollback 还原增量。
    var rec = s.recovery.load();
    val opId = nextPendingOpId(mutate rec, now);
    rec.pendingClaims.set(opId, PendingClaim {
        kind: PENDING_CLAIM_KIND_TICKET,
        owner: msg.owner,
        roundId: msg.roundId,
        userQueryId: msg.queryId,
        revertPrincipal: payPrincipal > 0,
        revertImm: payImm > 0,
        revertLockedRaw: payLocked,
        amountRaw: totalPay,
        createdAt: now,
    }.toCell());
    s.recovery = rec.toCell();
    s.save();

    reserveRcBalance(inboundTon);
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
            addPrincipal: payPrincipal > 0,
            addImm: payImm > 0,
            addLockedRaw: payLocked,
        },
    }).send(SEND_MODE_PAY_FEES_SEPARATELY | SEND_MODE_BOUNCE_ON_ACTION_FAIL);

    createMessage({
        bounce: BounceMode.Only256BitsOfBody,
        value: 0,
        dest: ownWallet(cfg),
        body: buildJettonTransfer(opId, totalPay as coins, msg.owner, msg.owner),
    }).send(SEND_MODE_CARRY_ALL_BALANCE | SEND_MODE_BOUNCE_ON_ACTION_FAIL);
}

// ===========================================================================
// 7. W3 Acknowledgements & Pull-Based Failed Refund Claim
// ===========================================================================
fun handleTicketStakeAck(sender: address, msg: TicketStakeAck) {
    var s = Storage.load();
    val cfg = s.config.load();
    val codes = cfg.codes.load();
    var rec = s.recovery.load();
    val found = rec.pendingStakes.get(msg.opId);
    if (!found.isFound) { return; }
    val ps = found.loadValue().load();
    assert (sender == calcTicketAddress(contract.getAddress(), ps.owner, ps.roundId, codes.ticketCode)) throw Errors.NotTicket;
    rec.pendingStakes.delete(msg.opId);
    s.recovery = rec.toCell();
    s.save();
}

fun handleClaimFailedRefund(sender: address, msg: ClaimFailedRefund, inboundTon: coins) {
    assert (inboundTon >= MIN_CLAIM_REFUND_VALUE) throw Errors.NotEnoughValue;
    assert (sender.getWorkchain() == BASECHAIN) throw Errors.WrongWorkchain;
    var s = Storage.load();
    val cfg = s.config.load();
    var rec = s.recovery.load();
    val found = rec.failedRefunds.get(sender);
    assert (found.isFound) throw Errors.NothingToClaim;
    val owed = found.loadValue();
    assert (owed > 0) throw Errors.NothingToClaim;

    val now = now64();
    rec.failedRefunds.delete(sender);
    val opId = nextPendingOpId(mutate rec, now);
    rec.pendingClaims.set(opId, PendingClaim {
        kind: PENDING_CLAIM_KIND_PULL_REFUND,
        owner: sender,
        roundId: 0 as uint32,
        userQueryId: msg.queryId,
        revertPrincipal: false,
        revertImm: false,
        revertLockedRaw: 0,
        amountRaw: owed,
        createdAt: now,
    }.toCell());
    s.recovery = rec.toCell();
    s.save();

    reserveRcBalance(inboundTon);
    emitEvent(EvFailedRefundClaimed { recipient: sender, amountRaw: owed });
    createMessage({
        bounce: BounceMode.Only256BitsOfBody,
        value: 0,
        dest: ownWallet(cfg),
        body: buildJettonTransfer(opId, owed as coins, sender, sender),
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

get fun get_round(roundId: uint32): RoundView {
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

get fun get_reward_preview(roundId: uint32, weightRaw: uint128): RewardPreview {
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

get fun get_ticket_address(owner: address, roundId: uint32): address {
    val codes = Storage.load().config.load().codes.load();
    return calcTicketAddress(contract.getAddress(), owner, roundId, codes.ticketCode);
}

get fun get_failed_refund(owner: address): uint128 {
    val rec = Storage.load().recovery.load();
    val found = rec.failedRefunds.get(owner);
    return found.isFound ? found.loadValue() : (0 as uint128);
}

get fun get_recovery_meta(): RecoveryMetaView {
    val rec = Storage.load().recovery.load();
    return {
        nextOpId: rec.nextOpId,
        hasPendingStakes: !rec.pendingStakes.isEmpty(),
        hasPendingClaims: !rec.pendingClaims.isEmpty(),
    };
}
