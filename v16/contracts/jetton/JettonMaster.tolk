// A9 Protocol v15 — Standard TEP-74 / TEP-89 Jetton Master (mint-once-then-drop-admin)
import "@gen/JettonWallet.code"
import "errors"
import "fees-management"
import "jetton-utils"
import "messages"
import "sharding"
import "storage"

// 10,000,000,000 A9 (9 decimals)
const TOTAL_SUPPLY_RAW: coins = 10000000000000000000;

contract JettonMaster {
    author: "A9 Protocol"
    version: "15.0.0"
    description: "Standard TEP-74 Jetton Master: mint 10B A9 once then permanently renounce admin."
    storage: MasterStorage
    incomingMessages: MasterAllowedMessage
}

type MasterAllowedMessage =
    | MintOnce
    | BurnNotificationForMinter
    | RequestWalletAddress
    | ChangeMinterAdmin
    | ClaimMinterAdmin
    | DropMinterAdmin
    | ChangeMinterMetadata
    | TopUpTons

fun onBouncedMessage(in: InMessageBounced) {
    in.bouncedBody.skipBouncedPrefix();
    val msg = lazy InternalTransferStep.fromSlice(in.bouncedBody);
    var storage = lazy MasterStorage.load();
    storage.totalSupply -= msg.jettonAmount;
    storage.save();
}

fun requireAdmin(sender: address, admin: address?) {
    assert (admin != null) throw JettonErrors.MintClosed;
    assert (sender == admin!) throw JettonErrors.NotOwner;
}

fun onInternalMessage(in: InMessage) {
    val msg = lazy MasterAllowedMessage.fromSlice(in.body);

    match (msg) {
        MintOnce => {
            var storage = lazy MasterStorage.load();
            assert (storage.adminAddress != null) throw JettonErrors.MintClosed;
            assert (in.senderAddress == storage.adminAddress!) throw JettonErrors.NotOwner;
            assert (storage.totalSupply == 0) throw JettonErrors.MintClosed;
            assert (msg.jettonAmount == TOTAL_SUPPLY_RAW) throw JettonErrors.MintAmountMismatch;
            assert (msg.recipient.getWorkchain() == MY_WORKCHAIN) throw JettonErrors.WrongWorkchain;
            assert (msg.totalTonAmount >= msg.tonAmount) throw JettonErrors.InvalidMintMessage;
            assert (in.valueCoins >= msg.totalTonAmount) throw JettonErrors.InvalidMintMessage;
            assert (msg.tonAmount >= ton("0.1")) throw JettonErrors.InvalidMintMessage;
            assert (in.valueCoins >= msg.tonAmount + ton("0.05")) throw JettonErrors.InvalidMintMessage;
            msg.forwardPayload.checkIsCorrectTlbEither();
            checkAmountIsEnoughToTransfer(msg.tonAmount, 0, in.originalForwardFee);

            storage.totalSupply = TOTAL_SUPPLY_RAW;
            storage.adminAddress = null;
            storage.nextAdminAddress = null;
            storage.save();

            reserveToncoinsOnBalance(ton("0.01"), RESERVE_MODE_EXACT_AMOUNT);

            val deployMsg = createMessage({
                bounce: BounceMode.Only256BitsOfBody,
                dest: calcDeployedJettonWallet(msg.recipient, contract.getAddress(), jettonWalletCompiledCode()),
                value: msg.tonAmount,
                body: InternalTransferStep {
                    queryId: msg.queryId,
                    jettonAmount: msg.jettonAmount,
                    transferInitiator: null,
                    sendExcessesTo: null,
                    forwardTonAmount: 0,
                    forwardPayload: msg.forwardPayload,
                },
            });
            deployMsg.send(SEND_MODE_PAY_FEES_SEPARATELY | SEND_MODE_BOUNCE_ON_ACTION_FAIL);
        }

        BurnNotificationForMinter => {
            var storage = lazy MasterStorage.load();
            assert (
                in.senderAddress == calcAddressOfJettonWallet(msg.burnInitiator, contract.getAddress(), jettonWalletCompiledCode())
            ) throw JettonErrors.NotValidWallet;
            assert (storage.totalSupply >= msg.jettonAmount) throw JettonErrors.BalanceError;
            storage.totalSupply -= msg.jettonAmount;
            storage.save();

            if (msg.sendExcessesTo != null) {
                createMessage({
                    bounce: BounceMode.NoBounce,
                    dest: msg.sendExcessesTo,
                    value: 0,
                    body: ReturnExcessesBack { queryId: msg.queryId },
                }).send(SEND_MODE_CARRY_ALL_REMAINING_MESSAGE_VALUE | SEND_MODE_IGNORE_ERRORS);
            }
        }

        RequestWalletAddress => {
            val ownerAddress: Cell<address>? = msg.includeOwnerAddress ? msg.ownerAddress.toCell() : null;
            var walletAddress: address? = null;
            if (msg.ownerAddress.getWorkchain() == MY_WORKCHAIN) {
                walletAddress = calcAddressOfJettonWallet(msg.ownerAddress, contract.getAddress(), jettonWalletCompiledCode());
            }
            createMessage({
                bounce: BounceMode.NoBounce,
                dest: in.senderAddress,
                value: 0,
                body: ResponseWalletAddress { queryId: msg.queryId, jettonWalletAddress: walletAddress, ownerAddress },
            }).send(SEND_MODE_CARRY_ALL_REMAINING_MESSAGE_VALUE | SEND_MODE_BOUNCE_ON_ACTION_FAIL);
        }

        ChangeMinterAdmin => {
            var storage = lazy MasterStorage.load();
            requireAdmin(in.senderAddress, storage.adminAddress);
            storage.nextAdminAddress = msg.newAdminAddress;
            storage.save();
        }

        ClaimMinterAdmin => {
            var storage = lazy MasterStorage.load();
            assert (storage.nextAdminAddress != null) throw JettonErrors.NotOwner;
            assert (in.senderAddress == storage.nextAdminAddress!) throw JettonErrors.NotOwner;
            storage.adminAddress = storage.nextAdminAddress;
            storage.nextAdminAddress = null;
            storage.save();
        }

        DropMinterAdmin => {
            var storage = lazy MasterStorage.load();
            requireAdmin(in.senderAddress, storage.adminAddress);
            storage.adminAddress = null;
            storage.nextAdminAddress = null;
            storage.save();
        }

        ChangeMinterMetadata => {
            var storage = lazy MasterStorage.load();
            requireAdmin(in.senderAddress, storage.adminAddress);
            storage.metadata = msg.newMetadata;
            storage.save();
        }

        TopUpTons => {}
        else => throw JettonErrors.InvalidMessage,
    }
}

get fun get_jetton_data(): JettonDataReply {
    val storage = lazy MasterStorage.load();
    return {
        totalSupply: storage.totalSupply,
        mintable: storage.adminAddress != null,
        adminAddress: storage.adminAddress,
        jettonContent: storage.metadata as Cell<OnchainMetadataReply>,
        jettonWalletCode: jettonWalletCompiledCode(),
    };
}

get fun get_wallet_address(ownerAddress: address): address {
    return calcAddressOfJettonWallet(ownerAddress, contract.getAddress(), jettonWalletCompiledCode());
}

get fun get_total_supply(): coins {
    return MasterStorage.load().totalSupply;
}
