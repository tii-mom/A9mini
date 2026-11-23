// A9 Protocol v16 — StakeTicket storage, messages, and deterministic address derivation.
import "types"

struct TicketStorage {
    rc: address
    owner: address
    roundId: uint32
    amountRaw: uint128
    weightRaw: uint128
    principalDone: bool
    immediateClaimed: bool
    lockedClaimedRaw: uint128
    pending: bool
}

fun TicketStorage.load(): TicketStorage {
    return TicketStorage.fromCell(contract.getData());
}

fun TicketStorage.save(self) {
    contract.setData(self.toCell());
}

// RC -> StakeTicket (op + opId in first 96 bits so Only256BitsOfBody bounce always carries opId)
struct (0x52540301) TicketAddStake {
    opId: uint64
    userQueryId: uint64
    amountRaw: uint128
    weightRaw: uint128
}

// RC -> StakeTicket (additive deltas so TicketConfirm commutes with any delayed TicketClaimRollback)
struct (0x52540302) TicketConfirm {
    queryId: uint64
    addPrincipal: bool
    addImm: bool
    addLockedRaw: uint128
}

// owner -> StakeTicket
struct (0x52540303) TicketClaim {
    queryId: uint64
}

// StakeTicket -> RC
struct (0x52540305) TicketClaimReq {
    queryId: uint64
    owner: address
    roundId: uint32
    amountRaw: uint128
    weightRaw: uint128
    principalDone: bool
    immediateClaimed: bool
    lockedClaimedRaw: uint128
}

// RC -> StakeTicket (rolls back exact claimed delta when own JettonWallet bounces; never touches pending flag)
struct (0x52540306) TicketClaimRollback {
    queryId: uint64
    revertPrincipal: bool
    revertImm: bool
    revertLockedRaw: uint128
}

// StakeTicket -> RC (confirms stake recorded so RC deletes transient pendingStake entry)
struct (0x52540307) TicketStakeAck {
    opId: uint64
}

struct TicketView {
    rc: address
    owner: address
    roundId: uint32
    amountRaw: uint128
    weightRaw: uint128
    principalDone: bool
    immediateClaimed: bool
    lockedClaimedRaw: uint128
    pending: bool
}

fun calcDeployedTicket(rc: address, owner: address, roundId: uint32, ticketCode: cell): AutoDeployAddress {
    val init: TicketStorage = {
        rc,
        owner,
        roundId,
        amountRaw: 0,
        weightRaw: 0,
        principalDone: false,
        immediateClaimed: false,
        lockedClaimedRaw: 0,
        pending: false,
    };
    return {
        workchain: BASECHAIN,
        stateInit: { code: ticketCode, data: init.toCell() },
    };
}

fun calcTicketAddress(rc: address, owner: address, roundId: uint32, ticketCode: cell): address {
    return calcDeployedTicket(rc, owner, roundId, ticketCode).calculateAddress();
}
