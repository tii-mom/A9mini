import "@stdlib/gas-payments"
import "errors"
import "sharding"

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
