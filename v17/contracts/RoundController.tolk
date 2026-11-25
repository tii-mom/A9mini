// A9 协议 v17.0 — 涨价解锁（Price-Unlock）极简主控合约
// 严格 O(1) 状态、零待决字典、32 位无限轮次、全员 1:1 分奖（单轮封顶 5x）、
// 24H 锁仓（头矿前 6H 享 5% 轻止损 / 之后 10% 止损）→ 封盘禁进禁出 → 12H 冲价（>= 8/12 达标）、
// 锁仓期提前解押（退 85% 烧 15%）、通关 20% 秒提 + 14 天逐秒解锁 + 3 折急提（7 折销毁）
import "@stdlib/gas-payments"
import "types"
import "jetton/storage"

contract RoundController {
    author: "A9 Protocol"
    version: "17.0.0"
    description: "Minimalist A9 v17.0 Price-Unlock RoundController with 6H 5% stop-loss, lock-only early exit, and 14D vesting with 30% instant cashout."
    storage: Storage
    incomingMessages: ControllerMessage
}

type ControllerMessage =
    | OpenRound
    | SettleRound
    | AbortRound
    | RetrySettlePayouts
    | TransferNotification
    | TicketClaimReq
    | TicketEarlyExitReq
    | ReturnExcessesIgnore
    | TopUpTons

// ===========================================================================
// 基础工具函数
// ===========================================================================
fun now64(): uint64 { return blockchain.now() as uint64; }

fun mulDiv(a: uint128, b: uint128, c: uint128): uint128 {
    return ((a as int) * (b as int) / (c as int)) as uint128;
}

fun ownWallet(cfg: ProtocolConfig): address {
    return calcAddressOfJettonWallet(contract.getAddress(), cfg.jettonMaster, cfg.codes.load().jettonWalletCode);
}

fun emitEvent<T>(body: T) {
    createExternalLogMessage({ dest: createAddressNone(), body }).send(SEND_MODE_REGULAR);
}

/** 补齐历史存储欠费并保底 RC_MIN_BALANCE，安全留存主控原有 GRAM 余额。 */
fun reserveRcBalance(inboundTon: coins) {
    val orig: int = contract.getOriginalBalance() as int;
    val target: int = orig - (inboundTon as int) + (contract.getStorageDuePayment() as int);
    val minBal: int = RC_MIN_BALANCE as int;
    reserveToncoinsOnBalance((target > minBal ? target : minBal) as coins, RESERVE_MODE_AT_MOST);
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

fun safeUserQid(queryId: uint64): uint64 {
    return (queryId & TEAM_QID_MASK) == TEAM_QID_PREFIX
        ? (queryId ^ TEAM_QID_PREFIX)
        : queryId;
}

/** 计算 80% 锁仓奖金在当前时刻的按秒线性解锁额度（主网 14 天匀速释放，永久累计不倒扣）。 */
fun unlockedLocked(timing: ProtocolTiming, rd: RoundData, locked: uint128, now: uint64): uint128 {
    if (locked == 0 || rd.settledAt == 0 || now <= rd.settledAt) { return 0; }
    val elapsed = now - rd.settledAt;
    val dur = timing.vestingSeconds as uint64;
    if (dur == 0 || elapsed >= dur) { return locked; }
    return mulDiv(locked, elapsed as uint128, dur as uint128);
}

// ===========================================================================
// Bounce 回滚恢复处理器
// ===========================================================================
fun onBouncedMessage(in: InMessageBounced) {
    in.bouncedBody.skipBouncedPrefix();
    if (in.bouncedBody.remainingBitsCount() < 32) {
        return;
    }
    val op = in.bouncedBody.loadUint(32) as uint32;

    // 1. TicketAddStake (193 bits <= 256 bits) 发生 bounce：精确回滚当轮总锁仓、头矿锁仓与笔数
    if (op == OP_TICKET_ADD_STAKE) {
        if (in.bouncedBody.remainingBitsCount() < 64 + 32 + 64 + 1) {
            return;
        }
        val _qid = in.bouncedBody.loadUint(64) as uint64;
        val roundId = in.bouncedBody.loadUint(32) as uint32;
        val amt: uint128 = (in.bouncedBody.loadUint(64) as uint64) as uint128;
        val isEarly = in.bouncedBody.loadBool();

        var s = Storage.load();
        val found = s.rounds.get(roundId);
        if (!found.isFound) { return; }
        var rd = found.loadValue();
        var meta = rd.meta.load();
        rd.totalStakeRaw = rd.totalStakeRaw >= amt ? (rd.totalStakeRaw - amt) : (0 as uint128);
        if (isEarly) {
            rd.earlyStakeRaw = rd.earlyStakeRaw >= amt ? (rd.earlyStakeRaw - amt) : (0 as uint128);
        }
        if (meta.stakeCount > 0) { meta.stakeCount -= 1; }
        rd.meta = meta.toCell();
        s.rounds.set(roundId, rd);
        s.save();
        emitEvent(EvDepositBounced { roundId, amountRaw: amt, isEarly });
        return;
    }

    // 2. 来自主控自身 JettonWallet 的转账/销毁 bounce：记录至 O(1) 待重试余额或发射审计事件
    var s = Storage.load();
    val cfg = s.config.load();
    if (in.senderAddress != ownWallet(cfg)) {
        return;
    }

    if (op == OP_JETTON_BURN && in.bouncedBody.remainingBitsCount() >= 68) {
        val _qid = in.bouncedBody.loadUint(64) as uint64;
        val amt = in.bouncedBody.loadCoins() as uint128;
        if (amt > 0) {
            s.pendingBurnRaw += amt;
            s.save();
        }
        return;
    }

    if (op == OP_JETTON_TRANSFER && in.bouncedBody.remainingBitsCount() >= 68) {
        val qid = in.bouncedBody.loadUint(64) as uint64;
        val amt = in.bouncedBody.loadCoins() as uint128;
        if (amt > 0) {
            if ((qid & TEAM_QID_MASK) == TEAM_QID_PREFIX) {
                s.pendingTeamReleaseRaw += amt;
                s.save();
            } else {
                emitEvent(EvClaimPayoutBounced { queryId: qid, amountRaw: amt });
            }
        }
    }
}

// ===========================================================================
// 消息路由
// ===========================================================================
fun onInternalMessage(in: InMessage) {
    if (in.body.isEmpty()) { return; }
    val msg = lazy ControllerMessage.fromSlice(in.body);
    match (msg) {
        OpenRound => handleOpenRound(in.senderAddress, msg),
        SettleRound => handleSettleRound(in.senderAddress, msg, in.valueCoins),
        AbortRound => handleAbortRound(),
        RetrySettlePayouts => handleRetrySettlePayouts(msg.queryId, in.valueCoins),
        TransferNotification => handleDeposit(in.senderAddress, msg, in.valueCoins),
        TicketClaimReq => handleTicketClaim(in.senderAddress, msg, in.valueCoins),
        TicketEarlyExitReq => handleEarlyExit(in.senderAddress, msg, in.valueCoins),
        ReturnExcessesIgnore => {},
        TopUpTons => {},
        else => throw Errors.UnknownMessage,
    }
}

// ===========================================================================
// 1. 开启新一轮 (OpenRound — 走廊 [1.30x, 2.00x])
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
    assert (
        msg.targetPriceUsdE8 >= mulDiv(basePrice, 13, 10) &&
        msg.targetPriceUsdE8 <= mulDiv(basePrice, 2, 1)
    ) throw Errors.BadTargetPrice;

    val baseReward = s.poolRemainingRaw < econ.roundRewardRaw ? s.poolRemainingRaw : econ.roundRewardRaw;
    val budget = baseReward + s.carryRaw;
    assert (budget > 0) throw Errors.ProtocolEnded;
    s.poolRemainingRaw -= baseReward;
    s.carryRaw = 0;

    val now = now64();
    val closeAt = now + (timing.stakeDurationSeconds as uint64);
    s.currentRoundId = nextId;
    s.rounds.set(nextId, {
        status: STATUS_ACTIVE,
        targetPriceUsdE8: msg.targetPriceUsdE8,
        twap24hUsdE8: msg.twap24hUsdE8,
        stakeOpenAt: now,
        stakeCloseAt: closeAt,
        settledAt: 0,
        totalStakeRaw: 0,
        earlyStakeRaw: 0,
        rewardBudgetRaw: budget,
        qualifiedCandles: 0,
        meta: emptyMeta().toCell(),
    });
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
// 2. 质押入金与无效入金即时退回 (TransferNotification)
// ===========================================================================
fun refundInvalidDeposit(wallet: address, initiator: address?, amount: coins, inboundTon: coins, queryId: uint64) {
    if (initiator == null || initiator!.getWorkchain() != BASECHAIN || inboundTon < MIN_REFUND_VALUE) {
        return;
    }
    reserveRcBalance(inboundTon);
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
    if (p.remainingBitsCount() < 64 || (p.loadUint(32) as uint32) != OP_STAKE_DEPOSIT) {
        refundInvalidDeposit(wallet, msg.transferInitiator, msg.jettonAmount, inboundTon, msg.queryId);
        return;
    }
    val roundId = p.loadUint(32) as uint32;
    var owner: address? = msg.transferInitiator;
    var payloadValid = true;
    if (p.remainingBitsCount() >= 2) {
        val addrTag = p.preloadUint(2);
        // 严格要求标准地址且 anycast == 0 (0b100 == 4)，防止畸形地址解析抛异常吞币
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
    val timing = cfg.timing.load();
    val now = now64();
    val validOwner = payloadValid && owner != null && owner!.getWorkchain() == BASECHAIN;

    // 单笔入金 <= uint64 最大值（184 亿 A9 > 100 亿总供应量），保障 TicketAddStake bounce 精确回传
    val fitsU64 = (amount as int) <= 0xFFFFFFFFFFFFFFFF;
    if (validOwner && fitsU64 && s.currentRoundId > 0 && roundId == s.currentRoundId && amount >= econ.minStakeRaw && inboundTon >= MIN_DEPOSIT_VALUE) {
        var rd = s.rounds.get(roundId).loadValue();
        if (rd.status == STATUS_ACTIVE && now >= rd.stakeOpenAt && now < rd.stakeCloseAt) {
            val isEarly = now < rd.stakeOpenAt + (timing.earlyWindowSeconds as uint64);
            var meta = rd.meta.load();
            rd.totalStakeRaw += amount;
            if (isEarly) {
                rd.earlyStakeRaw += amount;
            }
            meta.stakeCount += 1;
            rd.meta = meta.toCell();
            s.rounds.set(roundId, rd);
            s.save();

            reserveRcBalance(inboundTon);
            emitEvent(EvDepositAccepted { roundId, owner: owner!, amountRaw: amount, isEarly });
            createMessage({
                bounce: BounceMode.Only256BitsOfBody,
                value: 0,
                dest: calcDeployedTicket(contract.getAddress(), owner!, roundId, cfg.codes.load().ticketCode),
                body: TicketAddStake { queryId: msg.queryId, roundId, amountRaw: amount as uint64, isEarly },
            }).send(SEND_MODE_CARRY_ALL_BALANCE | SEND_MODE_BOUNCE_ON_ACTION_FAIL);
            return;
        }
    }

    refundInvalidDeposit(wallet, msg.transferInitiator, msg.jettonAmount, inboundTon, msg.queryId);
}

// ===========================================================================
// 3. 锁仓期提前解押 (TicketEarlyExitReq — 仅限 24H 锁仓期内，退 85% 烧 15%)
// ===========================================================================
fun handleEarlyExit(sender: address, msg: TicketEarlyExitReq, inboundTon: coins) {
    assert (inboundTon >= MIN_RC_DUAL_CLAIM_VALUE) throw Errors.NotEnoughValue;
    var s = Storage.load();
    val cfg = s.config.load();
    assert (sender == calcTicketAddress(contract.getAddress(), msg.owner, msg.roundId, cfg.codes.load().ticketCode)) throw Errors.NotTicket;

    val found = s.rounds.get(msg.roundId);
    assert (found.isFound) throw Errors.BadRoundId;
    var rd = found.loadValue();
    assert (rd.status == STATUS_ACTIVE) throw Errors.BadRoundStatus;
    // 严格校验仅限 24H 锁仓期内可提前解押；进入 12H 冲价期封盘禁进禁出
    assert (now64() < rd.stakeCloseAt) throw Errors.LockClosed;

    val totalAmt = msg.earlyAmountRaw + msg.lateAmountRaw;
    assert (totalAmt > 0 && rd.totalStakeRaw >= totalAmt && rd.earlyStakeRaw >= msg.earlyAmountRaw) throw Errors.NothingToClaim;

    var meta = rd.meta.load();
    rd.totalStakeRaw -= totalAmt;
    rd.earlyStakeRaw -= msg.earlyAmountRaw;
    if (meta.stakeCount > 0) { meta.stakeCount -= 1; }
    rd.meta = meta.toCell();
    s.rounds.set(msg.roundId, rd);
    s.save();

    val refundRaw = mulDiv(totalAmt, BPS - EARLY_EXIT_BURN_BPS, BPS);
    val burnRaw = totalAmt - refundRaw;
    val safeQid = safeUserQid(msg.queryId);
    val wallet = ownWallet(cfg);

    reserveRcBalance(inboundTon);
    emitEvent(EvEarlyExited {
        owner: msg.owner,
        roundId: msg.roundId,
        refundRaw,
        burnedRaw: burnRaw,
    });

    createMessage({
        bounce: BounceMode.NoBounce,
        value: VALUE_TICKET_MSG,
        dest: sender,
        body: TicketConfirm {
            queryId: msg.queryId,
            principalDone: false,
            immediateClaimed: false,
            lockedClaimedRaw: 0,
            exited: true,
            forfeited: false,
            exitedEarlyRaw: msg.earlyAmountRaw,
            exitedLateRaw: msg.lateAmountRaw,
        },
    }).send(SEND_MODE_PAY_FEES_SEPARATELY | SEND_MODE_BOUNCE_ON_ACTION_FAIL);

    if (burnRaw > 0) {
        sendJettonFromBalance(wallet, buildJettonBurn(safeQid, burnRaw as coins, msg.owner));
    }

    createMessage({
        bounce: BounceMode.Only256BitsOfBody,
        value: 0,
        dest: wallet,
        body: buildJettonTransfer(safeQid, refundRaw as coins, msg.owner, msg.owner),
    }).send(SEND_MODE_CARRY_ALL_BALANCE | SEND_MODE_BOUNCE_ON_ACTION_FAIL);
}

// ===========================================================================
// 4. 单笔结算轮次 (SettleRound — 通关 5x 封顶；失败头矿烧 5% / 普通烧 10% + 烧半池)
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

    if (rd.totalStakeRaw == 0) {
        // 无人锁仓的空轮无论达标与否均视为无效轮，奖池与团队额度 100% 滚存，零销毁、不计胜场
        s.carryRaw += rd.rewardBudgetRaw;
        s.teamCarryRaw += teamBase;
        rd.rewardBudgetRaw = 0;
        rd.status = msg.qualifiedCandles >= timing.minQualifiedCandles ? STATUS_SUCCEEDED : STATUS_FAILED;
        rd.meta = meta.toCell();
        s.rounds.set(msg.roundId, rd);
    } else if (msg.qualifiedCandles >= timing.minQualifiedCandles) {
        val capRaw: int = (rd.totalStakeRaw as int) * (MAX_REWARD_MULTIPLIER as int);
        val distributable: uint128 = (rd.rewardBudgetRaw as int) < capRaw ? rd.rewardBudgetRaw : (capRaw as uint128);
        s.carryRaw += (rd.rewardBudgetRaw - distributable);

        val teamBudget = teamBase + s.teamCarryRaw;
        teamReleased = rd.rewardBudgetRaw > 0 ? mulDiv(teamBudget, distributable, rd.rewardBudgetRaw) : (0 as uint128);
        s.teamCarryRaw = teamBudget - teamReleased;

        s.successCount += 1;
        s.lastSuccessAt = now;

        val immTotal = mulDiv(distributable, IMMEDIATE_BPS as uint128, BPS);
        val lockedTotal = distributable - immTotal;

        rd.status = STATUS_SUCCEEDED;
        rd.rewardBudgetRaw = distributable;
        meta.immediateBps = IMMEDIATE_BPS;
        meta.lockedTotalRaw = lockedTotal;
        rd.meta = meta.toCell();
        s.rounds.set(msg.roundId, rd);
    } else {
        // 向上取整折半销毁奖池与团队结转；锁仓本金按头矿 5% / 普通 10% 精确止损销毁，严格保证退本总额不产生 1 纳币缺口
        val rewardBurn = (rd.rewardBudgetRaw + 1) / 2;
        s.carryRaw += (rd.rewardBudgetRaw - rewardBurn);
        val teamCarryBurn = (s.teamCarryRaw + 1) / 2;
        s.teamCarryRaw -= teamCarryBurn;

        val lateStake = rd.totalStakeRaw - rd.earlyStakeRaw;
        val earlyRefundMax = mulDiv(rd.earlyStakeRaw, BPS - FAIL_EARLY_BURN_BPS, BPS);
        val lateRefundMax = mulDiv(lateStake, BPS - FAIL_LATE_BURN_BPS, BPS);
        val stakeBurn = rd.totalStakeRaw - earlyRefundMax - lateRefundMax;
        totalBurn = rewardBurn + stakeBurn + teamBase + teamCarryBurn;

        rd.status = STATUS_FAILED;
        rd.meta = meta.toCell();
        s.rounds.set(msg.roundId, rd);
    }

    if (s.poolRemainingRaw == 0 && s.carryRaw == 0) {
        s.endAt = now;
        totalBurn += s.teamPoolRemainingRaw + s.teamCarryRaw;
        s.teamPoolRemainingRaw = 0;
        s.teamCarryRaw = 0;
    }

    s.save();

    val wallet = ownWallet(cfg);
    reserveRcBalance(inboundTon);
    if (teamReleased > 0) {
        val teamQid: uint64 = TEAM_QID_PREFIX | (msg.roundId as uint64);
        sendJettonFromBalance(wallet, buildJettonTransfer(teamQid, teamReleased as coins, econ.teamWallet, contract.getAddress()));
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
// 5. 超时中止逃生门 (AbortRound) 与 6. O(1) 滞留出账无许可重试 (RetrySettlePayouts)
// ===========================================================================
fun handleAbortRound() {
    var s = Storage.load();
    assert (s.currentRoundId > 0) throw Errors.BadRoundId;
    var rd = s.rounds.get(s.currentRoundId).loadValue();
    assert (rd.status == STATUS_ACTIVE) throw Errors.BadRoundStatus;

    val timing = s.config.load().timing.load();
    val now = now64();
    assert (now >= rd.stakeCloseAt + (timing.observationSeconds as uint64) + (timing.abortTimeoutSeconds as uint64)) throw Errors.TooEarly;

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

fun handleRetrySettlePayouts(queryId: uint64, inboundTon: coins) {
    assert (inboundTon >= MIN_SETTLE_VALUE) throw Errors.NotEnoughValue;
    var s = Storage.load();
    val teamAmt = s.pendingTeamReleaseRaw;
    val burnAmt = s.pendingBurnRaw;
    assert (teamAmt > 0 || burnAmt > 0) throw Errors.NothingToRetry;

    s.pendingTeamReleaseRaw = 0;
    s.pendingBurnRaw = 0;
    s.save();

    val cfg = s.config.load();
    val econ = cfg.econ.load();
    val wallet = ownWallet(cfg);
    reserveRcBalance(inboundTon);
    if (teamAmt > 0) {
        val teamQid: uint64 = TEAM_QID_PREFIX | ((queryId as uint32) as uint64);
        sendJettonFromBalance(wallet, buildJettonTransfer(teamQid, teamAmt as coins, econ.teamWallet, contract.getAddress()));
    }
    if (burnAmt > 0) {
        sendJettonFromBalance(wallet, buildJettonBurn(queryId, burnAmt as coins, contract.getAddress()));
    }
}

// ===========================================================================
// 7. 凭证领奖 / 自动止损退本 / 3 折急提核销 (TicketClaimReq)
// ===========================================================================
fun handleTicketClaim(sender: address, msg: TicketClaimReq, inboundTon: coins) {
    assert (inboundTon >= MIN_RC_CLAIM_VALUE) throw Errors.NotEnoughValue;
    val s = Storage.load();
    val cfg = s.config.load();
    assert (sender == calcTicketAddress(contract.getAddress(), msg.owner, msg.roundId, cfg.codes.load().ticketCode)) throw Errors.NotTicket;

    val found = s.rounds.get(msg.roundId);
    assert (found.isFound) throw Errors.BadRoundId;
    val rd = found.loadValue();
    assert (
        rd.status == STATUS_SUCCEEDED ||
        rd.status == STATUS_FAILED ||
        rd.status == STATUS_ABORTED
    ) throw Errors.NothingToClaim;

    val totalAmt = msg.earlyAmountRaw + msg.lateAmountRaw;
    assert (totalAmt > 0) throw Errors.NothingToClaim;

    var payPrincipal: uint128 = 0;
    var newPrincipalDone = msg.principalDone;
    if (!msg.principalDone) {
        if (rd.status == STATUS_FAILED) {
            // 未通关：头矿退 95%、普通退 90%（分段精确核算）
            val earlyRef = mulDiv(msg.earlyAmountRaw, BPS - FAIL_EARLY_BURN_BPS, BPS);
            val lateRef = mulDiv(msg.lateAmountRaw, BPS - FAIL_LATE_BURN_BPS, BPS);
            payPrincipal = earlyRef + lateRef;
        } else {
            // 通关或超时异常中止：100% 无损退回本金
            payPrincipal = totalAmt;
        }
        newPrincipalDone = true;
    }

    var payReward: uint128 = 0;
    var newImmClaimed = msg.immediateClaimed;
    var newLockedClaimed = msg.lockedClaimedRaw;
    var burnLocked: uint128 = 0;
    var cashoutDiscountRaw: uint128 = 0;
    var newForfeited = false;

    if (rd.status == STATUS_SUCCEEDED && rd.totalStakeRaw > 0) {
        val meta = rd.meta.load();
        val totalReward = mulDiv(rd.rewardBudgetRaw, totalAmt, rd.totalStakeRaw);
        val imm = mulDiv(totalReward, meta.immediateBps as uint128, BPS);
        val locked = totalReward - imm;

        if (!msg.immediateClaimed) {
            payReward += imm;
            newImmClaimed = true;
        }
        val unlockedNow = unlockedLocked(cfg.timing.load(), rd, locked, now64());
        if (unlockedNow > msg.lockedClaimedRaw) {
            payReward += (unlockedNow - msg.lockedClaimedRaw);
            newLockedClaimed = unlockedNow;
        }

        // 3 折急提：仅对尚未自然解锁的未来余额 unvested 按 30% 实发、70% 销毁；
        // 若已满 14 天 (unvested == 0)，即使误传 instantDiscount = true 也不销毁、100% 实发
        if (msg.instantDiscount && locked > newLockedClaimed) {
            assert (inboundTon >= MIN_RC_DUAL_CLAIM_VALUE) throw Errors.NotEnoughValue;
            val unvested = locked - newLockedClaimed;
            cashoutDiscountRaw = mulDiv(unvested, INSTANT_DISCOUNT_BPS, BPS);
            burnLocked = unvested - cashoutDiscountRaw;
            payReward += cashoutDiscountRaw;
            newLockedClaimed = locked;
            newForfeited = true;
        }
    }

    val totalPay = payPrincipal + payReward;
    assert (totalPay > 0 || burnLocked > 0) throw Errors.NothingToClaim;

    val safeClaimQid = safeUserQid(msg.queryId);
    val wallet = ownWallet(cfg);

    reserveRcBalance(inboundTon);
    emitEvent(EvClaimed {
        owner: msg.owner,
        roundId: msg.roundId,
        principalRaw: payPrincipal,
        rewardRaw: payReward,
    });
    if (burnLocked > 0) {
        emitEvent(EvInstantCashout {
            owner: msg.owner,
            roundId: msg.roundId,
            cashoutRaw: cashoutDiscountRaw,
            burnedRaw: burnLocked,
        });
    }

    createMessage({
        bounce: BounceMode.NoBounce,
        value: VALUE_TICKET_MSG,
        dest: sender,
        body: TicketConfirm {
            queryId: msg.queryId,
            principalDone: newPrincipalDone,
            immediateClaimed: newImmClaimed,
            lockedClaimedRaw: newLockedClaimed,
            exited: false,
            forfeited: newForfeited,
            exitedEarlyRaw: 0,
            exitedLateRaw: 0,
        },
    }).send(SEND_MODE_PAY_FEES_SEPARATELY | SEND_MODE_BOUNCE_ON_ACTION_FAIL);

    if (burnLocked > 0) {
        sendJettonFromBalance(wallet, buildJettonBurn(safeClaimQid, burnLocked as coins, msg.owner));
    }

    if (totalPay > 0) {
        createMessage({
            bounce: BounceMode.Only256BitsOfBody,
            value: 0,
            dest: wallet,
            body: buildJettonTransfer(safeClaimQid, totalPay as coins, msg.owner, msg.owner),
        }).send(SEND_MODE_CARRY_ALL_BALANCE | SEND_MODE_BOUNCE_ON_ACTION_FAIL);
    }
}

// ===========================================================================
// 只读查询接口 (Get Methods)
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
        pendingTeamReleaseRaw: s.pendingTeamReleaseRaw,
        pendingBurnRaw: s.pendingBurnRaw,
    };
}

get fun get_round(roundId: uint32): RoundView {
    val s = Storage.load();
    val timing = s.config.load().timing.load();
    val found = s.rounds.get(roundId);
    if (!found.isFound) {
        return {
            status: STATUS_UNOPENED,
            targetPriceUsdE8: 0, twap24hUsdE8: 0, stakeOpenAt: 0, stakeCloseAt: 0, settledAt: 0,
            totalStakeRaw: 0, earlyStakeRaw: 0, rewardBudgetRaw: 0, qualifiedCandles: 0,
            candleHash: 0 as uint256, immediateBps: 0,
            vestingSeconds: timing.vestingSeconds, earlyWindowSeconds: timing.earlyWindowSeconds,
            lockedTotalRaw: 0, stakeCount: 0,
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
        earlyStakeRaw: rd.earlyStakeRaw,
        rewardBudgetRaw: rd.rewardBudgetRaw,
        qualifiedCandles: rd.qualifiedCandles,
        candleHash: m.candleHash,
        immediateBps: m.immediateBps,
        vestingSeconds: timing.vestingSeconds,
        earlyWindowSeconds: timing.earlyWindowSeconds,
        lockedTotalRaw: m.lockedTotalRaw,
        stakeCount: m.stakeCount,
    };
}

get fun get_reward_preview(roundId: uint32, stakeAmountRaw: uint128): RewardPreview {
    val s = Storage.load();
    val found = s.rounds.get(roundId);
    if (!found.isFound || stakeAmountRaw == 0) {
        return { totalRewardRaw: 0, immediateRaw: 0, lockedRaw: 0, unlockedLockedRaw: 0, burnedLockedRaw: 0 };
    }
    val rd = found.loadValue();
    if (rd.status != STATUS_SUCCEEDED || rd.totalStakeRaw == 0) {
        return { totalRewardRaw: 0, immediateRaw: 0, lockedRaw: 0, unlockedLockedRaw: 0, burnedLockedRaw: 0 };
    }
    val meta = rd.meta.load();
    val total = mulDiv(rd.rewardBudgetRaw, stakeAmountRaw, rd.totalStakeRaw);
    val imm = mulDiv(total, meta.immediateBps as uint128, BPS);
    val locked = total - imm;
    val unlocked = unlockedLocked(s.config.load().timing.load(), rd, locked, now64());
    return { totalRewardRaw: total, immediateRaw: imm, lockedRaw: locked, unlockedLockedRaw: unlocked, burnedLockedRaw: 0 };
}

get fun get_jetton_wallet_address(): address {
    return ownWallet(Storage.load().config.load());
}

get fun get_ticket_address(owner: address, roundId: uint32): address {
    return calcTicketAddress(contract.getAddress(), owner, roundId, Storage.load().config.load().codes.load().ticketCode);
}
