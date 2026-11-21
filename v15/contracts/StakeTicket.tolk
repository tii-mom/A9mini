// A9 Protocol v15 — Minimalist StakeTicket: one per (owner, roundId).
// Holds no jettons; acts as an O(1) sharded receipt verified by RoundController via address derivation.
import "types"
import "ticket"

contract StakeTicket {
    author: "A9 Protocol"
    version: "15.0.0"
    description: "Minimalist per-owner, per-round stake receipt for A9 v15."
    storage: TicketStorage
    incomingMessages: TicketMessage
}

type TicketMessage = TicketAddStake | TicketConfirm | TicketClaim

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
        st.pending = false;
        st.save();
        returnExcess(st.owner, 0);
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
