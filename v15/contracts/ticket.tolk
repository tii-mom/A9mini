// A9 Protocol v15 — StakeTicket storage, messages, and deterministic address derivation.
import "types"

struct TicketStorage {
    rc: address
    owner: address
    roundId: uint8
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

// RC -> StakeTicket
struct (0x52540301) TicketAddStake {
    queryId: uint64
    amountRaw: uint128
    weightRaw: uint128
}

// RC -> StakeTicket
struct (0x52540302) TicketConfirm {
    queryId: uint64
    principalDone: bool
    immediateClaimed: bool
    lockedClaimedRaw: uint128
}

// owner -> StakeTicket
struct (0x52540303) TicketClaim {
    queryId: uint64
}

// StakeTicket -> RC
struct (0x52540305) TicketClaimReq {
    queryId: uint64
    owner: address
    roundId: uint8
    amountRaw: uint128
    weightRaw: uint128
    principalDone: bool
    immediateClaimed: bool
    lockedClaimedRaw: uint128
}

struct TicketView {
    rc: address
    owner: address
    roundId: uint8
    amountRaw: uint128
    weightRaw: uint128
    principalDone: bool
    immediateClaimed: bool
    lockedClaimedRaw: uint128
    pending: bool
}

fun calcDeployedTicket(rc: address, owner: address, roundId: uint8, ticketCode: cell): AutoDeployAddress {
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

fun calcTicketAddress(rc: address, owner: address, roundId: uint8, ticketCode: cell): address {
    return calcDeployedTicket(rc, owner, roundId, ticketCode).calculateAddress();
}
