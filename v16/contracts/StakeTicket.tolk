// A9 协议 v16 — 极简质押凭证子合约（单用户单轮，不持有代币，O(1) 确定性地址验真）
import "types"

contract StakeTicket {
    author: "A9 Protocol"
    version: "16.2.0"
    description: "Minimalist per-owner, per-round stake receipt for A9 v16.2."
    storage: TicketStorage
    incomingMessages: TicketMessage
}

type TicketMessage = TicketAddStake | TicketConfirm | TicketClaim

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

/** 当主控拒绝领奖请求（如无可领额度）发生 bounce 时，校验来源并自动解除 pending 锁。 */
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
            assert (msg.roundId == st.roundId) throw Errors.BadRoundId;
            val amt: uint128 = msg.amountRaw as uint128;
            val weight: uint128 = ((amt as int) * (msg.timingBps as int) / (BPS as int)) as uint128;
            st.amountRaw += amt;
            st.weightRaw += weight;
            st.save();
            returnExcess(st.owner, msg.queryId);
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
            st.principalDone = msg.principalDone;
            st.immediateClaimed = msg.immediateClaimed;
            st.lockedClaimedRaw = msg.lockedClaimedRaw;
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
        amountRaw: st.amountRaw,
        weightRaw: st.weightRaw,
        principalDone: st.principalDone,
        immediateClaimed: st.immediateClaimed,
        lockedClaimedRaw: st.lockedClaimedRaw,
        pending: st.pending,
    };
}
