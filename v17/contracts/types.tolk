// A9 协议 v17.0 — 涨价解锁（Price-Unlock）极简常量、错误码、主控/凭证存储结构、消息、事件与只读视图
// 核心规则：
// - 全员 1 A9 = 1 份公平分奖（单轮封顶 5x，超额 100% 滚存下轮）；100 A9 起投
// - 24H 锁仓（头矿前 6H 享 5% 轻止损，之后 10% 止损）→ 封盘禁进禁出 → 12H 冲价（>= 8/12 达标）
// - 锁仓期内随时支持提前解押（退 85% 本金，扣 15% 销毁）；冲价期禁止提前解押
// - 通关退 100% 本金 + 20% 秒提 + 80% 分 14 天逐秒解锁；支持未解锁部分 3 折急提（7 折销毁）
// - 未通关永不爆仓：头矿退 95%（烧 5%）、普通退 90%（烧 10%），另烧一半奖池与一半团队结转

// ===========================================================================
// 消息操作码 (Opcodes)
// ===========================================================================
const OP_OPEN_ROUND: uint32 = 0x52540001;
const OP_SETTLE_ROUND: uint32 = 0x52540002;
const OP_ABORT_ROUND: uint32 = 0x52540003;
const OP_RETRY_SETTLE_PAYOUTS: uint32 = 0x52540005;  // 无许可重放因 bounce 滞留的团队释放/销毁
const OP_STAKE_DEPOSIT: uint32 = 0x52540010;         // TEP-74 forward_payload 操作码（32 位轮号）

const OP_TICKET_ADD_STAKE: uint32 = 0x52540301;
const OP_TICKET_CONFIRM: uint32 = 0x52540302;
const OP_TICKET_CLAIM: uint32 = 0x52540303;
const OP_TICKET_CLAIM_REQ: uint32 = 0x52540305;
const OP_TICKET_EARLY_EXIT: uint32 = 0x52540306;     // v17: 用户发起提前解押（仅限 24H 锁仓期内）
const OP_TICKET_EARLY_EXIT_REQ: uint32 = 0x52540307; // v17: 凭证转发给主控的提前解押请求

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
const IMMEDIATE_BPS: uint16 = 2000;                  // 通关 20% 秒提；余下 80% 分 14 天逐秒解锁
const MAX_REWARD_MULTIPLIER: uint128 = 5;            // 单轮奖金封顶 5 倍币（超额 100% 滚存下轮）
const FAIL_EARLY_BURN_BPS: uint128 = 500;            // 头矿 6H 未通关：扣 5% 止损销毁（退 95%）
const FAIL_LATE_BURN_BPS: uint128 = 1000;            // 普通未通关：扣 10% 止损销毁（退 90%）
const EARLY_EXIT_BURN_BPS: uint128 = 1500;           // 提前解押：扣 15% 销毁（退 85%）
const INSTANT_DISCOUNT_BPS: uint128 = 3000;          // 3 折急提：未解锁余额 30% 秒提 + 70% 销毁

const VALUE_JETTON_ACTION: coins = ton("0.12");
const VALUE_TICKET_MSG: coins = ton("0.02");
const TICKET_MIN_BALANCE: coins = ton("0.02");
const RC_MIN_BALANCE: coins = ton("0.1");
const MIN_DEPOSIT_VALUE: coins = ton("0.1");
const MIN_REFUND_VALUE: coins = ton("0.06");
const MIN_CLAIM_VALUE: coins = ton("0.22");
const MIN_RC_CLAIM_VALUE: coins = ton("0.16");
const MIN_DUAL_CLAIM_VALUE: coins = ton("0.34");     // 提前解押 / 3 折急提（发转币 + 销毁 2 笔 Jetton 动作）
const MIN_RC_DUAL_CLAIM_VALUE: coins = ton("0.28");
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
    LockClosed = 225,        // 已过 24H 锁仓封盘时间，冲价期禁止提前解押
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
    stakeDurationSeconds: uint32                     // 主网 24H = 86,400s
    earlyWindowSeconds: uint32                       // 主网头矿 6H = 21,600s
    observationSeconds: uint32                       // 主网 12H 冲价 = 43,200s
    candleCount: uint8                               // 主网 12 根 1H K 线
    minQualifiedCandles: uint8                       // 主网 >= 8 根达标
    abortTimeoutSeconds: uint32                      // 主网 7 天 = 604,800s
    vestingSeconds: uint32                           // 主网 14 天 = 1,209,600s
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
    earlyStakeRaw: uint128                           // 头矿 6H 锁仓总额（失败享 5% 轻止损）
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
// StakeTicket 凭证存储、消息与确定性地址派生（单 Cell 955 bits <= 1023 bits）
// ===========================================================================
struct TicketStorage {
    rc: address
    owner: address
    roundId: uint32
    earlyAmountRaw: uint128                          // 头矿 6H 锁仓额（未通关退 95%）
    lateAmountRaw: uint128                           // 6H 后锁仓额（未通关退 90%）
    principalDone: bool
    immediateClaimed: bool
    lockedClaimedRaw: uint128
    exited: bool
    forfeited: bool
    pending: bool
}

fun TicketStorage.load(): TicketStorage { return TicketStorage.fromCell(contract.getData()); }
fun TicketStorage.save(self) { contract.setData(self.toCell()); }

// 精确控制总位宽 = 32 + 64 + 32 + 64 + 1 = 193 bits <= 256 bits，确保 Only256BitsOfBody bounce 完整回传供主控精确回滚
struct (0x52540301) TicketAddStake {
    queryId: uint64
    roundId: uint32
    amountRaw: uint64
    isEarly: bool
}

// 单 Cell 总位宽 = 32 + 64 + 1 + 1 + 128 + 1 + 1 + 128 + 128 = 484 bits <= 1023 bits
struct (0x52540302) TicketConfirm {
    queryId: uint64
    principalDone: bool
    immediateClaimed: bool
    lockedClaimedRaw: uint128
    exited: bool
    forfeited: bool
    exitedEarlyRaw: uint128
    exitedLateRaw: uint128
}

struct (0x52540303) TicketClaim {
    queryId: uint64
    instantDiscount: bool
}

struct (0x52540305) TicketClaimReq {
    queryId: uint64
    owner: address
    roundId: uint32
    earlyAmountRaw: uint128
    lateAmountRaw: uint128
    principalDone: bool
    immediateClaimed: bool
    lockedClaimedRaw: uint128
    instantDiscount: bool
}

struct (0x52540306) TicketEarlyExit {
    queryId: uint64
}

struct (0x52540307) TicketEarlyExitReq {
    queryId: uint64
    owner: address
    roundId: uint32
    earlyAmountRaw: uint128
    lateAmountRaw: uint128
}

struct TicketView {
    rc: address
    owner: address
    roundId: uint32
    amountRaw: uint128
    earlyAmountRaw: uint128
    lateAmountRaw: uint128
    principalDone: bool
    immediateClaimed: bool
    lockedClaimedRaw: uint128
    exited: bool
    forfeited: bool
    pending: bool
}

fun calcDeployedTicket(rc: address, owner: address, roundId: uint32, ticketCode: cell): AutoDeployAddress {
    val init: TicketStorage = {
        rc, owner, roundId,
        earlyAmountRaw: 0, lateAmountRaw: 0,
        principalDone: false, immediateClaimed: false, lockedClaimedRaw: 0,
        exited: false, forfeited: false, pending: false,
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
    isEarly: bool
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
    isEarly: bool
}

struct (0x52540108) EvClaimPayoutBounced {
    queryId: uint64
    amountRaw: uint128
}

struct (0x52540109) EvEarlyExited {
    owner: address
    roundId: uint32
    refundRaw: uint128
    burnedRaw: uint128
}

struct (0x5254010A) EvInstantCashout {
    owner: address
    roundId: uint32
    cashoutRaw: uint128
    burnedRaw: uint128
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
    earlyStakeRaw: uint128
    rewardBudgetRaw: uint128
    qualifiedCandles: uint8
    candleHash: uint256
    immediateBps: uint16
    vestingSeconds: uint32
    earlyWindowSeconds: uint32
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
