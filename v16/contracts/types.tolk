// A9 Protocol v16 — Minimalist constants, errors, storage, messages, events, and views.

// ===========================================================================
// Opcodes
// ===========================================================================
const OP_OPEN_ROUND: uint32 = 0x52540001;          // roundOpener: open next round
const OP_SETTLE_ROUND: uint32 = 0x52540002;        // keeper / roundOpener: single-tx settle
const OP_ABORT_ROUND: uint32 = 0x52540003;         // anyone: escape hatch after abortTimeout
const OP_BURN_INACTIVE_LOCKED: uint32 = 0x52540004; // anyone: burn unresolved slices after 90d
const OP_CLAIM_FAILED_REFUND: uint32 = 0x52540005;  // user: pull escrowed failed/low-gas refund
const OP_STAKE_DEPOSIT: uint32 = 0x52540010;       // forward_payload op of TEP-74 transfer

// RC <-> StakeTicket
const OP_TICKET_ADD_STAKE: uint32 = 0x52540301;    // RC -> Ticket (deploy / top-up stake)
const OP_TICKET_CONFIRM: uint32 = 0x52540302;      // RC -> Ticket (update claimed state after Jetton transfer succeeds)
const OP_TICKET_CLAIM: uint32 = 0x52540303;        // owner -> Ticket
const OP_TICKET_CLAIM_REQ: uint32 = 0x52540305;      // Ticket -> RC
const OP_TICKET_CLAIM_ROLLBACK: uint32 = 0x52540306; // RC -> Ticket (rollback claimed delta on Jetton transfer bounce)
const OP_TICKET_STAKE_ACK: uint32 = 0x52540307;      // Ticket -> RC (acknowledge stake recorded; clears transient pendingStake)

// Standard TEP-74 opcodes
const OP_JETTON_TRANSFER: uint32 = 0x0f8a7ea5;
const OP_JETTON_BURN: uint32 = 0x595f07bc;

// ===========================================================================
// Round status (4 clean states)
// ===========================================================================
const STATUS_UNOPENED: uint8 = 0;
const STATUS_ACTIVE: uint8 = 1;     // staking in [stakeOpenAt, stakeCloseAt), observing after
const STATUS_SUCCEEDED: uint8 = 2;
const STATUS_FAILED: uint8 = 3;
const STATUS_ABORTED: uint8 = 4;

// ===========================================================================
// Protocol economics & gas constants
// ===========================================================================
const MAX_ROUNDS: uint32 = 4294967295;
const BPS: uint128 = 10000;
const MAX_REWARD_MULTIPLIER: uint128 = 15;
const TIMING_BPS_FIRST: uint128 = 20000;   // 2.0x (first 1/3 of staking window)
const TIMING_BPS_SECOND: uint128 = 14000;  // 1.4x (middle 1/3)
const TIMING_BPS_LAST: uint128 = 10000;    // 1.0x (last 1/3)

const VALUE_JETTON_ACTION: coins = ton("0.1");
const VALUE_TICKET_MSG: coins = ton("0.025");
const VALUE_TICKET_ACK: coins = ton("0.025");
const TICKET_MIN_BALANCE: coins = ton("0.02");
const RC_MIN_BALANCE: coins = ton("0.1");
const MIN_DEPOSIT_VALUE: coins = ton("0.12");
const MIN_REFUND_VALUE: coins = ton("0.08");
const MIN_ESCROW_GAS: coins = ton("0.015");
const MIN_ESCROW_AMOUNT: uint128 = 1000000000;       // 1 A9: sub-1-A9 dust with <0.015 TON is ignored (anti-griefing)
const MIN_CLAIM_REFUND_VALUE: coins = ton("0.12");
const MIN_CLAIM_VALUE: coins = ton("0.2");
const MIN_RC_CLAIM_VALUE: coins = ton("0.15");
const MIN_SETTLE_VALUE: coins = ton("0.25");

const PENDING_CLAIM_KIND_TICKET: uint8 = 1;
const PENDING_CLAIM_KIND_INSTANT_REFUND: uint8 = 2;
const PENDING_CLAIM_KIND_PULL_REFUND: uint8 = 3;
const PENDING_GC_TTL: uint64 = 300;
const PENDING_OP_FLAG: uint64 = 0x8000000000000000;
const NON_PENDING_QUERY_MASK: uint64 = 0x7FFFFFFFFFFFFFFF;

// ===========================================================================
// Errors
// ===========================================================================
enum Errors {
    Unauthorized = 101,
    NotJettonWallet = 104,
    UnknownMessage = 106,

    BadRoundId = 200,
    BadRoundStatus = 201,
    ProtocolEnded = 204,
    TooEarly = 208,
    BadInput = 211,
    BadTargetPrice = 216,

    NothingToClaim = 230,
    NotEnoughValue = 234,
    WrongWorkchain = 235,
    NotTicket = 236,
    NotOwner = 237,
    TicketPending = 238,
    NothingToBurn = 240,
}

// ===========================================================================
// Config (immutable after deployment)
// ===========================================================================
struct ProtocolEcon {
    teamWallet: address
    p0UsdE8: uint128
    roundRewardRaw: uint128
    teamRoundRaw: uint128
    minStakeRaw: uint128
}

struct ProtocolTiming {
    stakeDurationSeconds: uint32   // mainnet: 129,600 (36h)
    observationSeconds: uint32     // mainnet: 86,400 (24h)
    candleCount: uint8             // mainnet: 24
    minQualifiedCandles: uint8     // mainnet: 16
    abortTimeoutSeconds: uint32    // mainnet: 604,800 (7d)
    fallbackUnlockSeconds: uint32  // mainnet: 2,592,000 (30d)
    inactivityBurnSeconds: uint32  // mainnet: 7,776,000 (90d)
}

struct ProtocolCodes {
    jettonWalletCode: cell
    ticketCode: cell
}

struct ProtocolConfig {
    keeper: address
    roundOpener: address
    jettonMaster: address
    econ: Cell<ProtocolEcon>
    timing: Cell<ProtocolTiming>
    codes: Cell<ProtocolCodes>
}

// ===========================================================================
// Round & root storage (strictly O(1) per round, zero pending dicts)
// ===========================================================================
struct RoundMeta {
    candleHash: uint256
    immediateBps: uint16
    lockedSlices: uint8
    unlockedSlices: uint8
    burnedSlices: uint8
    lockedTotalRaw: uint128
    stakeCount: uint32
}

struct RoundData {
    status: uint8
    targetPriceUsdE8: uint128
    twap24hUsdE8: uint128
    stakeOpenAt: uint64
    stakeCloseAt: uint64
    settledAt: uint64
    totalStakeRaw: uint128
    totalWeightRaw: uint128
    rewardBudgetRaw: uint128
    qualifiedCandles: uint8
    meta: Cell<RoundMeta>
}

struct PendingStake {
    roundId: uint32
    owner: address
    refundTo: address
    amountRaw: uint128
    weightRaw: uint128
    userQueryId: uint64
    createdAt: uint64
}

struct PendingClaim {
    kind: uint8
    owner: address
    roundId: uint32
    userQueryId: uint64
    revertPrincipal: bool
    revertImm: bool
    revertLockedRaw: uint128
    amountRaw: uint128
    createdAt: uint64
}

struct RecoveryState {
    nextOpId: uint64
    pendingStakes: map<uint64, Cell<PendingStake>>
    pendingClaims: map<uint64, Cell<PendingClaim>>
    failedRefunds: map<address, uint128>
}

fun emptyRecovery(): RecoveryState {
    return {
        nextOpId: 0,
        pendingStakes: [],
        pendingClaims: [],
        failedRefunds: [],
    };
}

struct Storage {
    config: Cell<ProtocolConfig>
    rounds: map<uint32, RoundData>
    recovery: Cell<RecoveryState>
    currentRoundId: uint32
    successCount: uint32
    poolRemainingRaw: uint128      // starts at 7,000,000,000 A9
    carryRaw: uint128
    teamPoolRemainingRaw: uint128  // starts at 1,200,000,000 A9
    teamCarryRaw: uint128
    lastSuccessAt: uint64
    endAt: uint64
    activeLockedRounds: uint128     // up to 4 packed uint32 round IDs
}

fun Storage.load(): Storage {
    return Storage.fromCell(contract.getData());
}

fun Storage.save(self) {
    contract.setData(self.toCell());
}

fun emptyMeta(): RoundMeta {
    return {
        candleHash: 0 as uint256,
        immediateBps: 0,
        lockedSlices: 0,
        unlockedSlices: 0,
        burnedSlices: 0,
        lockedTotalRaw: 0,
        stakeCount: 0,
    };
}

// ===========================================================================
// Inbound messages
// ===========================================================================
struct (0x52540001) OpenRound {
    queryId: uint64
    twap24hUsdE8: uint128
    targetPriceUsdE8: uint128
}

struct (0x52540002) SettleRound {
    queryId: uint64
    roundId: uint32
    qualifiedCandles: uint8
    candleHash: uint256
}

struct (0x52540003) AbortRound {
    queryId: uint64
}

struct (0x52540004) BurnInactiveLocked {
    queryId: uint64
}

struct (0x52540005) ClaimFailedRefund {
    queryId: uint64
}

struct (0x7362d09c) TransferNotification {
    queryId: uint64
    jettonAmount: coins
    transferInitiator: address?
    forwardPayload: RemainingBitsAndRefs
}

struct (0xd53276db) ReturnExcessesIgnore {
    queryId: uint64
}

struct (0xd372158c) TopUpTons {}

// ===========================================================================
// External-out events (for indexer / UI)
// ===========================================================================
struct (0x52540101) EvRoundOpened {
    roundId: uint32
    twap24hUsdE8: uint128
    targetPriceUsdE8: uint128
    rewardBudgetRaw: uint128
    stakeOpenAt: uint64
    stakeCloseAt: uint64
}

struct (0x52540102) EvRoundSettled {
    roundId: uint32
    status: uint8
    qualifiedCandles: uint8
    candleHash: uint256
    totalStakeRaw: uint128
    rewardBudgetRaw: uint128
    teamReleasedRaw: uint128
    burnedRaw: uint128
    carryAfterRaw: uint128
}

struct (0x52540103) EvDepositAccepted {
    roundId: uint32
    owner: address
    amountRaw: uint128
    weightRaw: uint128
}

struct (0x52540104) EvDepositRefunded {
    recipient: address
    amountRaw: uint128
}

struct (0x52540105) EvClaimed {
    owner: address
    roundId: uint32
    principalRaw: uint128
    rewardRaw: uint128
}

struct (0x52540106) EvInactiveLockedBurned {
    burnedRaw: uint128
    at: uint64
}

struct (0x52540107) EvDepositRefundEscrowed {
    recipient: address
    amountRaw: uint128
}

struct (0x52540108) EvStakeBounced {
    roundId: uint32
    owner: address
    recipient: address
    amountRaw: uint128
}

struct (0x52540109) EvClaimBounced {
    owner: address
    roundId: uint32
    amountRaw: uint128
}

struct (0x5254010A) EvFailedRefundClaimed {
    recipient: address
    amountRaw: uint128
}

// ===========================================================================
// Clean get-method views
// ===========================================================================
struct ProtocolStateView {
    currentRoundId: uint32
    successCount: uint32
    poolRemainingRaw: uint128
    carryRaw: uint128
    teamPoolRemainingRaw: uint128
    teamCarryRaw: uint128
    lastSuccessAt: uint64
    endAt: uint64
    activeLockedRounds: uint128
}

struct RoundView {
    status: uint8
    targetPriceUsdE8: uint128
    twap24hUsdE8: uint128
    stakeOpenAt: uint64
    stakeCloseAt: uint64
    settledAt: uint64
    totalStakeRaw: uint128
    totalWeightRaw: uint128
    rewardBudgetRaw: uint128
    qualifiedCandles: uint8
    candleHash: uint256
    immediateBps: uint16
    lockedSlices: uint8
    unlockedSlices: uint8
    burnedSlices: uint8
    lockedTotalRaw: uint128
    stakeCount: uint32
}

struct RewardPreview {
    totalRewardRaw: uint128
    immediateRaw: uint128
    lockedRaw: uint128
    unlockedLockedRaw: uint128
    burnedLockedRaw: uint128
}

struct RecoveryMetaView {
    nextOpId: uint64
    hasPendingStakes: bool
    hasPendingClaims: bool
}
