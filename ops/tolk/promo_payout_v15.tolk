// A9 Protocol v15 — Zero-contract promo hot-wallet TEP-74 A9 payout script (Acton 1.1.0).
// Always sets sendExcessesTo = promoHotWallet so unused gas returns to the hot wallet (0 project gas).
import "@acton/env"
import "@acton/testing/assert"
import "@acton/types/transaction"
import "@acton/types/big_array"
import "@acton/emulation/network"
import "@acton/io"
import "@acton/fmt"
import "@acton/emulation/scripts"
import "@contracts/types"

fun reqInt(name: string): int {
    val v = env<int>(name);
    if (v == null || v! <= 0) { Assert.fail(format("missing positive {}", name)); }
    return v!;
}

fun reqAddr(name: string): address {
    val v = env<address>(name);
    if (v == null) { Assert.fail(format("missing {}", name)); }
    return v!;
}

fun reqStr(name: string): string {
    val v = env<string>(name);
    if (v == null) { Assert.fail(format("missing {}", name)); }
    return v!;
}

fun main() {
    if (!(env<bool>("OPS_EXECUTE") ?? false)) {
        println("DRY-RUN: promo_payout_v15 skipped.");
        return;
    }
    val hotWallet = scripts.wallet(reqStr("A9_PROMO_HOT_WALLET_NAME"));
    val master = reqAddr("A9_JETTON_MASTER_ADDRESS");
    val recipient = reqAddr("A9_PAYOUT_RECIPIENT");
    val amountRaw = reqInt("A9_PAYOUT_AMOUNT_RAW") as coins;
    val gasNano = (env<int>("A9_PROMO_TRANSFER_GAS_NANO") ?? 50000000) as coins;
    val qid = (env<int>("A9_QUERY_ID") ?? 1) as uint64;

    val hotJettonWallet = net.runGetMethod<address>(master, "get_wallet_address", [hotWallet.address]);
    val body = beginCell()
        .storeUint(OP_JETTON_TRANSFER, 32)
        .storeUint(qid, 64)
        .storeCoins(amountRaw)
        .storeAddress(recipient)
        .storeAddress(hotWallet.address) // CRITICAL: excesses return to promoHotWallet
        .storeMaybeRef(null)
        .storeCoins(0)
        .storeUint(0, 1)
        .endCell();

    val trace = net.send(hotWallet.address, createMessage({
        bounce: true,
        value: gasNano,
        dest: hotJettonWallet,
        body,
    })).waitForTrace();
    if (trace == null) { Assert.fail("promo payout trace unavailable"); }
    val firstTx = trace!.at(0).tx as cell;
    println("PROMO_PAYOUT_TX=0x{:x}", firstTx.hash());
}
