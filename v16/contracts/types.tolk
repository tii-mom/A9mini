// A9 协议 v16 — 极简常量、错误码、主控/凭证存储结构、消息、事件与只读视图

// ===========================================================================
// 消息操作码 (Opcodes)
// ===========================================================================
const OP_OPEN_ROUND: uint32 = 0x52540001;
const OP_SETTLE_ROUND: uint32 = 0x52540002;
const OP_ABORT_ROUND: uint32 = 0x52540003;
const OP_BURN_INACTIVE_LOCKED: uint32 = 0x52540004;
const OP_STAKE_DEPOSIT: uint32 = 0x52540010;        // v16 TEP-74 forward_payload 操作码（32 位轮号）

const OP_TICKET_ADD_STAKE: uint32 = 0x52540301;
const OP_TICKET_CONFIRM: uint32 = 0x52540302;
const OP_TICKET_CLAIM: uint32 = 0x52540303;
const OP_TICKET_CLAIM_REQ: uint32 = 0x52540305;

const OP_JETTON_TRANSFER: uint32 = 0x0f8a7ea5;
const OP_JETTON_BURN: uint32 = 0x595f07bc;

// ===========================================================================
// 轮次状态与经济学 / Gas 常量
// ===========================================================================
const STATUS_UNOPENED: uint8 = 0;
const STATUS_ACTIVE: uint8 = 1;
const STATUS_SUCCEEDED: uint8 = 2;
const STATUS_FAILED: uint8 = 3;
const STATUS_ABORTED: uint8 = 4;

const MAX_ROUNDS: uint32 = 4294967295;
const BPS: uint128 = 10000;
const MAX_REWARD_MULTIPLIER: uint128 = 15;
const TIMING_BPS_FIRST: uint128 = 20000;            // 前 1/3 质押期：2.0x 早鸟权重
const TIMING_BPS_SECOND: uint128 = 14000;           // 中 1/3 质押期：1.4x 权重
const TIMING_BPS_LAST: uint128 = 10000;             // 后 1/3 质押期：1.0x 权重

const VALUE_JETTON_ACTION: coins = ton("0.1");
const VALUE_TICKET_MSG: coins = ton("0.02");
const TICKET_MIN_BALANCE: coins = ton("0.02");
const RC_MIN_BALANCE: coins = ton("0.1");
const MIN_DEPOSIT_VALUE: coins = ton("0.1");
const MIN_REFUND_VALUE: coins = ton("0.06");
const MIN_CLAIM_VALUE: coins = ton("0.2");
const MIN_RC_CLAIM_VALUE: coins = ton("0.15");
const MIN_SETTLE_VALUE: coins = ton("0.25");

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
// 协议配置与 O(1) 主控存储（零待决字典）
// ===========================================================================
struct ProtocolEcon {
    teamWallet: address
    p0UsdE8: uint128
    roundRewardRaw: uint128
    teamRoundRaw: uint128
    minStakeRaw: uint128
}

struct ProtocolTiming {
    stakeDurationSeconds: uint32
    observationSeconds: uint32
    candleCount: uint8
    minQualifiedCandles: uint8
    abortTimeoutSeconds: uint32
    fallbackUnlockSeconds: uint32
    inactivityBurnSeconds: uint32
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

struct Storage {
    config: Cell<ProtocolConfig>
    rounds: map<uint32, RoundData>
    currentRoundId: uint32
    successCount: uint32
    poolRemainingRaw: uint128
    carryRaw: uint128
    teamPoolRemainingRaw: uint128
    teamCarryRaw: uint128
    lastSuccessAt: uint64
    endAt: uint64
    activeLockedRounds: uint128                     // 最多打包 4 个活跃锁定轮号（4 × uint32）
}

fun Storage.load(): Storage { return Storage.fromCell(contract.getData()); }
fun Storage.save(self) { contract.setData(self.toCell()); }

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
// StakeTicket 凭证存储、消息与确定性地址派生
// ===========================================================================
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

fun TicketStorage.load(): TicketStorage { return TicketStorage.fromCell(contract.getData()); }
fun TicketStorage.save(self) { contract.setData(self.toCell()); }

struct (0x52540301) TicketAddStake {
    queryId: uint64
    amountRaw: uint128
    weightRaw: uint128
}

struct (0x52540302) TicketConfirm {
    queryId: uint64
    principalDone: bool
    immediateClaimed: bool
    lockedClaimedRaw: uint128
}

struct (0x52540303) TicketClaim { queryId: uint64 }

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
        rc, owner, roundId,
        amountRaw: 0, weightRaw: 0,
        principalDone: false, immediateClaimed: false, lockedClaimedRaw: 0, pending: false,
    };
    return { workchain: BASECHAIN, stateInit: { code: ticketCode, data: init.toCell() } };
}

fun calcTicketAddress(rc: address, owner: address, roundId: uint32, ticketCode: cell): address {
    return calcDeployedTicket(rc, owner, roundId, ticketCode).calculateAddress();
}

// ===========================================================================
// RoundController 入站消息、链上事件与只读视图
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

struct (0x52540003) AbortRound { queryId: uint64 }
struct (0x52540004) BurnInactiveLocked { queryId: uint64 }

struct (0x7362d09c) TransferNotification {
    queryId: uint64
    jettonAmount: coins
    transferInitiator: address?
    forwardPayload: RemainingBitsAndRefs
}

struct (0xd53276db) ReturnExcessesIgnore { queryId: uint64 }

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
