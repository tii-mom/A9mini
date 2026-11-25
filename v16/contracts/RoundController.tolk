// A9 协议 v16.2 — 极简协议主控合约（严格 O(1) 状态、零待决字典、32 位无限轮次、40 天按秒线性释放）
import "@stdlib/gas-payments"
import "types"
import "jetton/storage"

contract RoundController {
    author: "A9 Protocol"
    version: "16.2.0"
    description: "Minimalist A9 v16.2 RoundController with 20% immediate + 80% 40-day linear vesting."
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

fun timingBps(rd: RoundData, now: uint64): uint16 {
    val third = (rd.stakeCloseAt - rd.stakeOpenAt) / 3;
    val elapsed = now - rd.stakeOpenAt;
    if (elapsed < third) { return TIMING_BPS_FIRST; }
    if (elapsed < third * 2) { return TIMING_BPS_SECOND; }
    return TIMING_BPS_LAST;
}

/** 计算 80% 锁仓奖励在当前时刻的按秒线性解锁额度（主网 40 天匀速释放 = 每日 2%，永久累计不倒扣）。 */
fun unlockedLocked(timing: ProtocolTiming, rd: RoundData, locked: uint128, now: uint64): uint128 {
    if (locked == 0 || rd.settledAt == 0 || now <= rd.settledAt) { return 0; }
    val elapsed = now - rd.settledAt;
    val dur = timing.vestingSeconds as uint64;
    if (dur == 0 || elapsed >= dur) { return locked; }
    return mulDiv(locked, elapsed as uint128, dur as uint128);
}

// ===========================================================================
// Bounce 回滚恢复处理器 (P0-2)
// ===========================================================================
fun onBouncedMessage(in: InMessageBounced) {
    in.bouncedBody.skipBouncedPrefix();
    if (in.bouncedBody.remainingBitsCount() < 32) {
        return;
    }
    val op = in.bouncedBody.loadUint(32) as uint32;

    // 1. TicketAddStake (208 bits <= 256 bits) 发生 bounce：精确回滚当轮总质押、总权重与笔数
    if (op == OP_TICKET_ADD_STAKE) {
        if (in.bouncedBody.remainingBitsCount() < 64 + 32 + 64 + 16) {
            return;
        }
        val _qid = in.bouncedBody.loadUint(64) as uint64;
        val roundId = in.bouncedBody.loadUint(32) as uint32;
        val amt: uint128 = (in.bouncedBody.loadUint(64) as uint64) as uint128;
        val tBps = in.bouncedBody.loadUint(16) as uint16;
        val weight = mulDiv(amt, tBps as uint128, BPS);

        var s = Storage.load();
        val found = s.rounds.get(roundId);
        if (!found.isFound) { return; }
        var rd = found.loadValue();
        var meta = rd.meta.load();
        rd.totalStakeRaw = rd.totalStakeRaw >= amt ? (rd.totalStakeRaw - amt) : (0 as uint128);
        rd.totalWeightRaw = rd.totalWeightRaw >= weight ? (rd.totalWeightRaw - weight) : (0 as uint128);
        if (meta.stakeCount > 0) { meta.stakeCount -= 1; }
        rd.meta = meta.toCell();
        s.rounds.set(roundId, rd);
        s.save();
        emitEvent(EvDepositBounced { roundId, amountRaw: amt, weightRaw: weight });
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
        ReturnExcessesIgnore => {},
        TopUpTons => {},
        else => throw Errors.UnknownMessage,
    }
}

// ===========================================================================
// 1. 开启新一轮 (OpenRound)
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
        msg.targetPriceUsdE8 >= mulDiv(basePrice, 3, 2) &&
        msg.targetPriceUsdE8 <= mulDiv(basePrice, 5, 2)
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
        totalWeightRaw: 0,
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
    val now = now64();
    val validOwner = payloadValid && owner != null && owner!.getWorkchain() == BASECHAIN;

    // 单笔入金 <= uint64 最大值（184 亿 A9 > 100 亿总供应量），保障 TicketAddStake bounce 精确回传
    val fitsU64 = (amount as int) <= 0xFFFFFFFFFFFFFFFF;
    if (validOwner && fitsU64 && s.currentRoundId > 0 && roundId == s.currentRoundId && amount >= econ.minStakeRaw && inboundTon >= MIN_DEPOSIT_VALUE) {
        var rd = s.rounds.get(roundId).loadValue();
        if (rd.status == STATUS_ACTIVE && now >= rd.stakeOpenAt && now < rd.stakeCloseAt) {
            val tBps = timingBps(rd, now);
            val weight = mulDiv(amount, tBps as uint128, BPS);
            var meta = rd.meta.load();
            rd.totalStakeRaw += amount;
            rd.totalWeightRaw += weight;
            meta.stakeCount += 1;
            rd.meta = meta.toCell();
            s.rounds.set(roundId, rd);
            s.save();

            reserveRcBalance(inboundTon);
            emitEvent(EvDepositAccepted { roundId, owner: owner!, amountRaw: amount, weightRaw: weight });
            createMessage({
                bounce: BounceMode.Only256BitsOfBody,
                value: 0,
                dest: calcDeployedTicket(contract.getAddress(), owner!, roundId, cfg.codes.load().ticketCode),
                body: TicketAddStake { queryId: msg.queryId, roundId, amountRaw: amount as uint64, timingBps: tBps },
            }).send(SEND_MODE_CARRY_ALL_BALANCE | SEND_MODE_BOUNCE_ON_ACTION_FAIL);
            return;
        }
    }

    refundInvalidDeposit(wallet, msg.transferInitiator, msg.jettonAmount, inboundTon, msg.queryId);
}

// ===========================================================================
// 3. 单笔结算轮次 (SettleRound)
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
        // P1-3 对称规则：无人质押的空轮无论达标与否均视为无效轮，奖池与团队额度 100% 滚存，不销毁、不计胜场
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
        // P0-3: 向上取整折半销毁，杜绝最后 1 raw A9 无限死循环永远无法触发 endAt
        val rewardBurn = (rd.rewardBudgetRaw + 1) / 2;
        s.carryRaw += (rd.rewardBudgetRaw - rewardBurn);
        val teamCarryBurn = (s.teamCarryRaw + 1) / 2;
        s.teamCarryRaw -= teamCarryBurn;
        totalBurn = rewardBurn + rd.totalStakeRaw + teamBase + teamCarryBurn;

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
    // P1-2: 保留主控原有 GRAM 与存储欠费，由本次 >= 0.35 TON 入金全额支付出账消息
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
// 4. 超时中止逃生门 (AbortRound) 与 5. O(1) 滞留出账无许可重试 (RetrySettlePayouts)
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
// 6. 凭证领奖核销 (TicketClaimReq — 无状态 O(1) 核验发放，20% 即时 + 40 天按秒线性)
// ===========================================================================
fun handleTicketClaim(sender: address, msg: TicketClaimReq, inboundTon: coins) {
    assert (inboundTon >= MIN_RC_CLAIM_VALUE) throw Errors.NotEnoughValue;
    val s = Storage.load();
    val cfg = s.config.load();
    assert (sender == calcTicketAddress(contract.getAddress(), msg.owner, msg.roundId, cfg.codes.load().ticketCode)) throw Errors.NotTicket;

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
        val unlockedNow = unlockedLocked(cfg.timing.load(), rd, locked, now64());
        if (unlockedNow > msg.lockedClaimedRaw) {
            payReward += (unlockedNow - msg.lockedClaimedRaw);
            newLockedClaimed = unlockedNow;
        }
    }

    val totalPay = payPrincipal + payReward;
    assert (totalPay > 0) throw Errors.NothingToClaim;

    // 剥离 TEAM_QID_PREFIX 防止用户自定义 queryId 与团队释放 bounce 标签冲突
    val safeClaimQid: uint64 = (msg.queryId & TEAM_QID_MASK) == TEAM_QID_PREFIX
        ? (msg.queryId ^ TEAM_QID_PREFIX)
        : msg.queryId;

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
            principalDone: newPrincipalDone,
            immediateClaimed: newImmClaimed,
            lockedClaimedRaw: newLockedClaimed,
        },
    }).send(SEND_MODE_PAY_FEES_SEPARATELY | SEND_MODE_BOUNCE_ON_ACTION_FAIL);

    createMessage({
        bounce: BounceMode.Only256BitsOfBody,
        value: 0,
        dest: ownWallet(cfg),
        body: buildJettonTransfer(safeClaimQid, totalPay as coins, msg.owner, msg.owner),
    }).send(SEND_MODE_CARRY_ALL_BALANCE | SEND_MODE_BOUNCE_ON_ACTION_FAIL);
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
            totalStakeRaw: 0, totalWeightRaw: 0, rewardBudgetRaw: 0, qualifiedCandles: 0,
            candleHash: 0 as uint256, immediateBps: 0, vestingSeconds: timing.vestingSeconds,
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
        totalWeightRaw: rd.totalWeightRaw,
        rewardBudgetRaw: rd.rewardBudgetRaw,
        qualifiedCandles: rd.qualifiedCandles,
        candleHash: m.candleHash,
        immediateBps: m.immediateBps,
        vestingSeconds: timing.vestingSeconds,
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
    val unlocked = unlockedLocked(s.config.load().timing.load(), rd, locked, now64());
    return { totalRewardRaw: total, immediateRaw: imm, lockedRaw: locked, unlockedLockedRaw: unlocked, burnedLockedRaw: 0 };
}

get fun get_jetton_wallet_address(): address {
    return ownWallet(Storage.load().config.load());
}

get fun get_ticket_address(owner: address, roundId: uint32): address {
    return calcTicketAddress(contract.getAddress(), owner, roundId, Storage.load().config.load().codes.load().ticketCode);
}
