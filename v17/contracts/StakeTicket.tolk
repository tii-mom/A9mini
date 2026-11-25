// A9 协议 v17.0 — 极简质押凭证子合约（单用户单轮，头矿/普通分账记账，支持锁仓期提前解押与 3 折急提）
import "types"

contract StakeTicket {
    author: "A9 Protocol"
    version: "17.0.0"
    description: "Minimalist per-owner, per-round stake receipt for A9 v17.0 Price-Unlock."
    storage: TicketStorage
    incomingMessages: TicketMessage
}

type TicketMessage = TicketAddStake | TicketConfirm | TicketClaim | TicketEarlyExit

struct (0xd53276db) TicketExcesses { queryId: uint64 }

/** 留存最小存储租金后，将剩余全部 GRAM 原路退还给凭证持有人。 */
fun returnExcess(owner: address, queryId: uint64) {
    reserveToncoinsOnBalance(TICKET_MIN_BALANCE, RESERVE_MODE_AT_MOST);
    createMessage({
        bounce: BounceMode.NoBounce,
        value: 0,
        dest: owner,
        body: TicketExcesses { queryId },
    }).send(SEND_MODE_CARRY_ALL_BALANCE | SEND_MODE_IGNORE_ERRORS);
}

/** 当主控拒绝领奖或提前解押请求发生 bounce 时，校验来源并自动解除 pending 锁。 */
fun onBouncedMessage(in: InMessageBounced) {
    in.bouncedBody.skipBouncedPrefix();
    if (in.bouncedBody.remainingBitsCount() < 32) {
        return;
    }
    val op = in.bouncedBody.loadUint(32) as uint32;
    if (op == OP_TICKET_CLAIM_REQ || op == OP_TICKET_EARLY_EXIT_REQ) {
        var st = lazy TicketStorage.load();
        if (in.senderAddress != st.rc) {
            return;
        }
        val qid: uint64 = in.bouncedBody.remainingBitsCount() >= 64
            ? (in.bouncedBody.loadUint(64) as uint64)
            : (0 as uint64);
        st.pending = false;
        st.save();
        returnExcess(st.owner, qid);
    }
}

fun onInternalMessage(in: InMessage) {
    val msg = lazy TicketMessage.fromSlice(in.body);
    match (msg) {
        TicketAddStake => {
            var st = lazy TicketStorage.load();
            assert (in.senderAddress == st.rc) throw Errors.NotTicket;
            assert (msg.roundId == st.roundId) throw Errors.BadRoundId;
            val amt: uint128 = msg.amountRaw as uint128;
            if (msg.isEarly) {
                st.earlyAmountRaw += amt;
            } else {
                st.lateAmountRaw += amt;
            }
            // 若此前在锁仓期内提前解押清零，允许本轮锁仓期内重新入池并复位 exited，避免吞币
            st.exited = false;
            st.save();
            returnExcess(st.owner, msg.queryId);
        }

        TicketClaim => {
            val needVal = msg.instantDiscount ? MIN_DUAL_CLAIM_VALUE : MIN_CLAIM_VALUE;
            assert (in.valueCoins >= needVal) throw Errors.NotEnoughValue;
            var st = lazy TicketStorage.load();
            assert (in.senderAddress == st.owner) throw Errors.NotOwner;
            assert (!st.pending) throw Errors.TicketPending;
            assert (st.earlyAmountRaw + st.lateAmountRaw > 0) throw Errors.NothingToClaim;

            st.pending = true;
            st.save();

            createMessage({
                bounce: BounceMode.Only256BitsOfBody,
                value: 0,
                dest: st.rc,
                body: TicketClaimReq {
                    queryId: msg.queryId,
                    owner: st.owner,
                    roundId: st.roundId,
                    earlyAmountRaw: st.earlyAmountRaw,
                    lateAmountRaw: st.lateAmountRaw,
                    principalDone: st.principalDone,
                    immediateClaimed: st.immediateClaimed,
                    lockedClaimedRaw: st.lockedClaimedRaw,
                    instantDiscount: msg.instantDiscount,
                },
            }).send(SEND_MODE_CARRY_ALL_REMAINING_MESSAGE_VALUE | SEND_MODE_BOUNCE_ON_ACTION_FAIL);
        }

        TicketEarlyExit => {
            assert (in.valueCoins >= MIN_DUAL_CLAIM_VALUE) throw Errors.NotEnoughValue;
            var st = lazy TicketStorage.load();
            assert (in.senderAddress == st.owner) throw Errors.NotOwner;
            assert (!st.pending) throw Errors.TicketPending;
            assert (st.earlyAmountRaw + st.lateAmountRaw > 0) throw Errors.NothingToClaim;

            st.pending = true;
            st.save();

            createMessage({
                bounce: BounceMode.Only256BitsOfBody,
                value: 0,
                dest: st.rc,
                body: TicketEarlyExitReq {
                    queryId: msg.queryId,
                    owner: st.owner,
                    roundId: st.roundId,
                    earlyAmountRaw: st.earlyAmountRaw,
                    lateAmountRaw: st.lateAmountRaw,
                },
            }).send(SEND_MODE_CARRY_ALL_REMAINING_MESSAGE_VALUE | SEND_MODE_BOUNCE_ON_ACTION_FAIL);
        }

        TicketConfirm => {
            var st = lazy TicketStorage.load();
            assert (in.senderAddress == st.rc) throw Errors.NotTicket;
            if (msg.exited) {
                // P0 并发安全修复：精确扣减本次解押额度，绝不清零在途并发到达的新 TicketAddStake 锁仓
                st.earlyAmountRaw = st.earlyAmountRaw >= msg.exitedEarlyRaw
                    ? (st.earlyAmountRaw - msg.exitedEarlyRaw)
                    : (0 as uint128);
                st.lateAmountRaw = st.lateAmountRaw >= msg.exitedLateRaw
                    ? (st.lateAmountRaw - msg.exitedLateRaw)
                    : (0 as uint128);
                st.principalDone = false;
                st.immediateClaimed = false;
                st.lockedClaimedRaw = 0;
                st.forfeited = false;
                st.exited = (st.earlyAmountRaw + st.lateAmountRaw) == 0;
            } else {
                st.principalDone = msg.principalDone;
                st.immediateClaimed = msg.immediateClaimed;
                st.lockedClaimedRaw = msg.lockedClaimedRaw;
                if (msg.forfeited) {
                    st.forfeited = true;
                }
            }
            st.pending = false;
            st.save();
            returnExcess(st.owner, msg.queryId);
        }

        else => throw Errors.UnknownMessage,
    }
}

get fun get_ticket_data(): TicketView {
    val st = lazy TicketStorage.load();
    return {
        rc: st.rc,
        owner: st.owner,
        roundId: st.roundId,
        amountRaw: st.earlyAmountRaw + st.lateAmountRaw,
        earlyAmountRaw: st.earlyAmountRaw,
        lateAmountRaw: st.lateAmountRaw,
        principalDone: st.principalDone,
        immediateClaimed: st.immediateClaimed,
        lockedClaimedRaw: st.lockedClaimedRaw,
        exited: st.exited,
        forfeited: st.forfeited,
        pending: st.pending,
    };
}
