// A9 Protocol v16 — Minimalist StakeTicket: one per (owner, roundId).
// Holds no jettons; acts as an O(1) sharded receipt verified by RoundController via address derivation.
import "types"
import "ticket"

contract StakeTicket {
    author: "A9 Protocol"
    version: "16.0.0"
    description: "Minimalist per-owner, per-round stake receipt with bounce-safe W3 recovery for A9 v16."
    storage: TicketStorage
    incomingMessages: TicketMessage
}

type TicketMessage = TicketAddStake | TicketConfirm | TicketClaim | TicketClaimRollback

struct (0xd53276db) TicketExcesses {
    queryId: uint64
}

fun returnExcess(owner: address, queryId: uint64) {
    reserveToncoinsOnBalance(TICKET_MIN_BALANCE, RESERVE_MODE_AT_MOST);
    createMessage({
        bounce: BounceMode.NoBounce,
        value: 0,
        dest: owner,
        body: TicketExcesses { queryId },
    }).send(SEND_MODE_CARRY_ALL_BALANCE | SEND_MODE_IGNORE_ERRORS);
}

fun onBouncedMessage(in: InMessageBounced) {
    in.bouncedBody.skipBouncedPrefix();
    if (in.bouncedBody.remainingBitsCount() < 32) {
        return;
    }
    if ((in.bouncedBody.loadUint(32) as uint32) == OP_TICKET_CLAIM_REQ) {
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
            st.amountRaw += msg.amountRaw;
            st.weightRaw += msg.weightRaw;
            st.save();
            // 向 RoundController 回执确认记票完成（不加 IGNORE_ERRORS，确保瞬时 pendingStakes 及时清理）
            createMessage({
                bounce: BounceMode.NoBounce,
                value: VALUE_TICKET_ACK,
                dest: st.rc,
                body: TicketStakeAck { opId: msg.opId },
            }).send(SEND_MODE_PAY_FEES_SEPARATELY | SEND_MODE_BOUNCE_ON_ACTION_FAIL);
            returnExcess(st.owner, msg.userQueryId);
        }

        TicketClaim => {
            assert (in.valueCoins >= MIN_CLAIM_VALUE) throw Errors.NotEnoughValue;
            var st = lazy TicketStorage.load();
            assert (in.senderAddress == st.owner) throw Errors.NotOwner;
            assert (!st.pending) throw Errors.TicketPending;
            assert (st.amountRaw > 0) throw Errors.NothingToClaim;

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
                    amountRaw: st.amountRaw,
                    weightRaw: st.weightRaw,
                    principalDone: st.principalDone,
                    immediateClaimed: st.immediateClaimed,
                    lockedClaimedRaw: st.lockedClaimedRaw,
                },
            }).send(SEND_MODE_CARRY_ALL_REMAINING_MESSAGE_VALUE | SEND_MODE_BOUNCE_ON_ACTION_FAIL);
        }

        TicketConfirm => {
            var st = lazy TicketStorage.load();
            assert (in.senderAddress == st.rc) throw Errors.NotTicket;
            // 采用增量累加（非绝对值覆写），与异步回滚 TicketClaimRollback 严格满足交换律
            if (msg.addPrincipal) {
                st.principalDone = true;
            }
            if (msg.addImm) {
                st.immediateClaimed = true;
            }
            if (msg.addLockedRaw > 0) {
                st.lockedClaimedRaw += msg.addLockedRaw;
            }
            st.pending = false;
            st.save();
            returnExcess(st.owner, msg.queryId);
        }

        TicketClaimRollback => {
            // 仅由 RoundController 收到自身 JettonWallet bounce 后触发：按精确增量回滚已领字段。
            // 因 TON 保证 RC->StakeTicket 严格 FIFO，本消息必晚于同次 TicketConfirm（已解除当次 pending）；
            // 此处严禁触碰 st.pending，避免并发新一次领奖进行中被提前解锁。
            var st = lazy TicketStorage.load();
            assert (in.senderAddress == st.rc) throw Errors.NotTicket;
            if (msg.revertPrincipal) {
                st.principalDone = false;
            }
            if (msg.revertImm) {
                st.immediateClaimed = false;
            }
            if (msg.revertLockedRaw > 0) {
                st.lockedClaimedRaw = st.lockedClaimedRaw >= msg.revertLockedRaw
                    ? (st.lockedClaimedRaw - msg.revertLockedRaw)
                    : (0 as uint128);
            }
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
        amountRaw: st.amountRaw,
        weightRaw: st.weightRaw,
        principalDone: st.principalDone,
        immediateClaimed: st.immediateClaimed,
        lockedClaimedRaw: st.lockedClaimedRaw,
        pending: st.pending,
    };
}
