// A9 协议 v16.2 — 极简常量、错误码、主控/凭证存储结构、消息、事件与只读视图
// 解锁机制：通关即退 100% 本金 + 秒领 20% 奖励；余下 80% 奖励按 40 天（每日 2%）按秒线性释放，永久累计不倒扣。

// ===========================================================================
// 消息操作码 (Opcodes)
// ===========================================================================
const OP_OPEN_ROUND: uint32 = 0x52540001;
const OP_SETTLE_ROUND: uint32 = 0x52540002;
const OP_ABORT_ROUND: uint32 = 0x52540003;
const OP_RETRY_SETTLE_PAYOUTS: uint32 = 0x52540005;  // 无许可重放因 bounce 滞留的团队释放/销毁
const OP_STAKE_DEPOSIT: uint32 = 0x52540010;         // v16 TEP-74 forward_payload 操作码（32 位轮号）

const OP_TICKET_ADD_STAKE: uint32 = 0x52540301;
const OP_TICKET_CONFIRM: uint32 = 0x52540302;
const OP_TICKET_CLAIM: uint32 = 0x52540303;
const OP_TICKET_CLAIM_REQ: uint32 = 0x52540305;

const OP_JETTON_TRANSFER: uint32 = 0x0f8a7ea5;
const OP_JETTON_BURN: uint32 = 0x595f07bc;

// 用于在 JettonTransfer bounce 中区分「结算团队释放」与「用户领奖发放」的 queryId 高 32 位标签
const TEAM_QID_PREFIX: uint64 = 0x5445414D00000000;
const TEAM_QID_MASK: uint64 = 0xFFFFFFFF00000000;

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
const IMMEDIATE_BPS: uint16 = 2000;                  // 恒定 20% 即时解锁；余下 80% 按 vestingSeconds 线性释放
const MAX_REWARD_MULTIPLIER: uint128 = 15;
const TIMING_BPS_FIRST: uint16 = 20000;              // 前 1/3 质押期：2.0x 早鸟权重
const TIMING_BPS_SECOND: uint16 = 14000;             // 中 1/3 质押期：1.4x 权重
const TIMING_BPS_LAST: uint16 = 10000;               // 后 1/3 质押期：1.0x 权重

const VALUE_JETTON_ACTION: coins = ton("0.12");
const VALUE_TICKET_MSG: coins = ton("0.02");
const TICKET_MIN_BALANCE: coins = ton("0.02");
const RC_MIN_BALANCE: coins = ton("0.1");
const MIN_DEPOSIT_VALUE: coins = ton("0.1");
const MIN_REFUND_VALUE: coins = ton("0.06");
const MIN_CLAIM_VALUE: coins = ton("0.22");
const MIN_RC_CLAIM_VALUE: coins = ton("0.16");
const MIN_SETTLE_VALUE: coins = ton("0.35");

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
    NothingToRetry = 240,
}

// ===========================================================================
// 协议配置与 O(1) 主控存储（零待决字典、零历史锁定队列）
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
    vestingSeconds: uint32                           // 80% 奖励线性释放总时长（主网 40 天 = 3,456,000s，每日 2%）
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
    pendingTeamReleaseRaw: uint128                   // 团队释放 bounce 回滚滞留额（O(1) 无许可可重试）
    pendingBurnRaw: uint128                          // 销毁 bounce 回滚滞留额（O(1) 无许可可重试）
}

fun Storage.load(): Storage { return Storage.fromCell(contract.getData()); }
fun Storage.save(self) { contract.setData(self.toCell()); }

fun emptyMeta(): RoundMeta {
    return {
        candleHash: 0 as uint256,
        immediateBps: 0,
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

// 精确控制总位宽 = 32 + 64 + 32 + 64 + 16 = 208 bits <= 256 bits，确保 Only256BitsOfBody bounce 完整回传供主控精确回滚
struct (0x52540301) TicketAddStake {
    queryId: uint64
    roundId: uint32
    amountRaw: uint64
    timingBps: uint16
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
struct (0x52540005) RetrySettlePayouts { queryId: uint64 }

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

struct (0x52540107) EvDepositBounced {
    roundId: uint32
    amountRaw: uint128
    weightRaw: uint128
}

struct (0x52540108) EvClaimPayoutBounced {
    queryId: uint64
    amountRaw: uint128
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
    pendingTeamReleaseRaw: uint128
    pendingBurnRaw: uint128
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
    vestingSeconds: uint32
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
