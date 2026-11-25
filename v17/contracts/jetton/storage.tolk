// A9 协议 v16 — 标准零魔改 TEP-74 / TEP-89 存储、消息、Gas 核算与地址派生工具
import "@stdlib/gas-payments"
import "@stdlib/strings"

const MY_WORKCHAIN = BASECHAIN
const SHARD_DEPTH = 8

const STORAGE_SIZE_MAX_WALLET_BITS = 1033
const STORAGE_SIZE_MAX_WALLET_CELLS = 3
const STORAGE_SIZE_INIT_STATE_WALLET_BITS = 900
const STORAGE_SIZE_INIT_STATE_WALLET_CELLS = 3
const MESSAGE_SIZE_BURN_NOTIFICATION_BITS = 754
const MESSAGE_SIZE_BURN_NOTIFICATION_CELLS = 1
const MESSAGE_SIZE_RETURN_EXCESSES_BITS = 128
const MESSAGE_SIZE_RETURN_EXCESSES_CELLS = 0
const MIN_STORAGE_DURATION = 5 * 365 * 24 * 3600

const GAS_CONSUMPTION_JETTON_TRANSFER = 6327
const GAS_CONSUMPTION_JETTON_RECEIVE = 7443
const GAS_CONSUMPTION_BURN_REQUEST = 4254
const GAS_CONSUMPTION_BURN_NOTIFICATION = 4071

enum JettonErrors {
    NotOwner = 73,
    NotValidWallet = 74,
    WrongWorkchain = 333,
    BalanceError = 47,
    NotEnoughGas = 48,
    InvalidMessage = 49,
    MintClosed = 75,
    MintAmountMismatch = 76,
    InvalidMintMessage = 77,
}

// 标准 3 字段 TEP-74 钱包存储（零协议耦合）
struct WalletStorage {
    jettonBalance: coins
    ownerAddress: address
    minterAddress: address
}

struct MasterStorage {
    totalSupply: coins
    adminAddress: address?
    nextAdminAddress: address?
    metadata: cell
}

fun MasterStorage.load(): MasterStorage { return MasterStorage.fromCell(contract.getData()); }
fun MasterStorage.save(self) { contract.setData(self.toCell()); }
fun WalletStorage.load(): WalletStorage { return WalletStorage.fromCell(contract.getData()); }
fun WalletStorage.save(self) { contract.setData(self.toCell()); }

struct JettonWalletDataReply {
    jettonBalance: coins
    ownerAddress: address
    minterAddress: address
    jettonWalletCode: cell
}

struct JettonDataReply {
    totalSupply: int
    mintable: bool
    adminAddress: address?
    jettonContent: Cell<OnchainMetadataReply>
    jettonWalletCode: cell
}

struct (0x00) OnchainMetadataReply {
    contentDict: map<uint256, string_prefixed0x>
}

// 标准 TEP-74 / TEP-89 消息与一次性铸币消息（op 0x15）
type ForwardPayloadRemainder = RemainingBitsAndRefs

struct (0b0) PayloadInline { value: RemainingBitsAndRefs }
struct (0b1) PayloadInRef { value: Cell<RemainingBitsAndRefs> }

struct (0x00000015) MintOnce {
    queryId: uint64
    recipient: address
    tonAmount: coins
    jettonAmount: coins
    totalTonAmount: coins
    @abi.clientType(PayloadInline | PayloadInRef)
    forwardPayload: RemainingBitsAndRefs
}

struct (0x0f8a7ea5) AskToTransfer {
    queryId: uint64
    jettonAmount: coins
    transferRecipient: address
    sendExcessesTo: address?
    customPayload: cell?
    forwardTonAmount: coins
    @abi.clientType(PayloadInline | PayloadInRef)
    forwardPayload: ForwardPayloadRemainder
}

struct (0x7362d09c) TransferNotificationForRecipient {
    queryId: uint64
    jettonAmount: coins
    transferInitiator: address?
    @abi.clientType(PayloadInline | PayloadInRef)
    forwardPayload: ForwardPayloadRemainder
}

struct (0x178d4519) InternalTransferStep {
    queryId: uint64
    jettonAmount: coins
    transferInitiator: address?
    sendExcessesTo: address?
    forwardTonAmount: coins
    @abi.clientType(PayloadInline | PayloadInRef)
    forwardPayload: ForwardPayloadRemainder
}

struct (0xd53276db) ReturnExcessesBack { queryId: uint64 }

struct (0x595f07bc) AskToBurn {
    queryId: uint64
    jettonAmount: coins
    sendExcessesTo: address?
    customPayload: cell?
}

struct (0x7bdd97de) BurnNotificationForMinter {
    queryId: uint64
    jettonAmount: coins
    burnInitiator: address
    sendExcessesTo: address?
}

struct (0x2c76b973) RequestWalletAddress {
    queryId: uint64
    ownerAddress: address
    includeOwnerAddress: bool
}

struct (0xd1735400) ResponseWalletAddress {
    queryId: uint64
    jettonWalletAddress: address?
    ownerAddress: Cell<address>?
}

struct (0x6501f354) ChangeMinterAdmin {
    queryId: uint64
    newAdminAddress: address
}

struct (0xfb88e119) ClaimMinterAdmin { queryId: uint64 }
struct (0x7431f221) DropMinterAdmin { queryId: uint64 }

struct (0xcb862902) ChangeMinterMetadata {
    queryId: uint64
    newMetadata: cell
}

struct (0xd372158c) TopUpTons {}

fun ForwardPayloadRemainder.checkIsCorrectTlbEither(self) {
    var mutableCopy = self;
    if (mutableCopy.loadMaybeRef() != null) {
        mutableCopy.assertEnd();
    }
}

// 地址派生与 Gas 核算函数
fun calcDeployedJettonWallet(
    ownerAddress: address,
    minterAddress: address,
    jettonWalletCode: cell,
): AutoDeployAddress {
    val emptyWalletStorage: WalletStorage = {
        jettonBalance: 0,
        ownerAddress,
        minterAddress,
    };
    return {
        workchain: MY_WORKCHAIN,
        stateInit: { code: jettonWalletCode, data: emptyWalletStorage.toCell() },
        toShard: { fixedPrefixLength: SHARD_DEPTH, closeTo: ownerAddress },
    };
}

fun calcAddressOfJettonWallet(
    ownerAddress: address,
    minterAddress: address,
    jettonWalletCode: cell,
): address {
    return calcDeployedJettonWallet(ownerAddress, minterAddress, jettonWalletCode).calculateAddress();
}

fun getPrecompiledGasConsumption(): int?
    asm "GETPRECOMPILEDGAS"

fun calculateJettonWalletMinStorageFee(): coins {
    return calculateStorageFee(
        MY_WORKCHAIN,
        MIN_STORAGE_DURATION,
        STORAGE_SIZE_MAX_WALLET_BITS,
        STORAGE_SIZE_MAX_WALLET_CELLS,
    );
}

fun forwardInitStateOverhead(): coins {
    return calculateForwardFeeWithoutLumpPrice(
        MY_WORKCHAIN,
        STORAGE_SIZE_INIT_STATE_WALLET_BITS,
        STORAGE_SIZE_INIT_STATE_WALLET_CELLS,
    );
}

fun calcMinimalTransferAmount(forwardTonAmount: int, fwdFee: int): int {
    val fwdCount = forwardTonAmount != 0 ? 2 : 1;
    val precompiled = getPrecompiledGasConsumption();
    val sendGas = precompiled == null ? GAS_CONSUMPTION_JETTON_TRANSFER : precompiled;
    val recvGas = precompiled == null ? GAS_CONSUMPTION_JETTON_RECEIVE : precompiled;

    return forwardTonAmount + fwdCount * fwdFee + forwardInitStateOverhead() +
        calculateForwardFee(MY_WORKCHAIN, MESSAGE_SIZE_RETURN_EXCESSES_BITS, MESSAGE_SIZE_RETURN_EXCESSES_CELLS) +
        calculateGasFee(MY_WORKCHAIN, sendGas) +
        calculateGasFee(MY_WORKCHAIN, recvGas) +
        calculateJettonWalletMinStorageFee();
}

fun checkAmountIsEnoughToTransfer(msgValue: int, forwardTonAmount: int, fwdFee: int) {
    assert (msgValue > calcMinimalTransferAmount(forwardTonAmount, fwdFee)) throw JettonErrors.NotEnoughGas;
}

fun calcMinimalBurnAmount(): coins {
    val precompiled = getPrecompiledGasConsumption();
    val sendGas = precompiled == null ? GAS_CONSUMPTION_BURN_REQUEST : precompiled;

    return calculateForwardFee(MY_WORKCHAIN, MESSAGE_SIZE_BURN_NOTIFICATION_BITS, MESSAGE_SIZE_BURN_NOTIFICATION_CELLS) +
        calculateForwardFee(MY_WORKCHAIN, MESSAGE_SIZE_RETURN_EXCESSES_BITS, MESSAGE_SIZE_RETURN_EXCESSES_CELLS) +
        calculateGasFee(MY_WORKCHAIN, sendGas) +
        calculateGasFee(MY_WORKCHAIN, GAS_CONSUMPTION_BURN_NOTIFICATION);
}

fun checkAmountIsEnoughToBurn(msgValue: int) {
    assert (msgValue > calcMinimalBurnAmount()) throw JettonErrors.NotEnoughGas;
}
