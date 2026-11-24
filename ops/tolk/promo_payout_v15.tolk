// A9 Protocol v15/v16 — Zero-contract promo/presale hot-wallet TEP-74 A9 payout script (Acton 1.1.0).
// Always sets sendExcessesTo = hotWallet so unused gas returns to the hot wallet (0 project gas).
import "@stdlib/strings"
import "@acton/env"
import "@acton/testing/assert"
import "@acton/tlb/maybe"
import "@acton/types/transaction"
import "@acton/types/big_array"
import "@acton/emulation/network"
import "@acton/io"
import "@acton/fmt"
import "@acton/emulation/scripts"
import "@contracts/types"
import "@contracts/jetton/storage"

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

fun assertSingleTxOk(item: SendResult, idx: int) {
    val rawCell = item.tx as cell;
    println("  tx[{}] = 0x{:x}", idx, rawCell.hash());
    val tx = item.tx.load();
    val descr = tx.description.load();
    if (descr is TlbTransOrd) {
        if (descr.aborted) {
            Assert.fail(format("tx[{}] aborted on-chain", idx));
        }
        val c = descr.computePh;
        if (c is TlbTrComputeVm) {
            val exitCode = c.data.load().exitCode;
            if (exitCode != 0 && exitCode != 1) {
                Assert.fail(format("tx[{}] failed compute exitCode={}", idx, exitCode));
            }
        } else {
            val skip = c.reason;
            if (!(skip is TlbCSkipNoState) || !(descr.bounce is TlbNone)) {
                Assert.fail(format("tx[{}] compute skipped unexpectedly", idx));
            }
        }
        val act = descr.action;
        if (!(act is TlbNone)) {
            val actionPh = act.value.load();
            if (!actionPh.success) {
                Assert.fail(format("tx[{}] failed action resultCode={}", idx, actionPh.resultCode));
            }
        }
    }
}

fun assertTraceOk(trace: SendResultList) {
    if (trace.size() == 0) { Assert.fail("promo payout trace is empty"); }
    var i = 0;
    while (i < trace.size()) {
        assertSingleTxOk(trace.at(i), i);
        i += 1;
    }
}

fun main() {
    val network = env<string>("A9_NETWORK") ?? "testnet";
    if (!network.equalTo("testnet") && !network.equalTo("mainnet")) {
        Assert.fail("A9_NETWORK must be testnet or mainnet");
    }
    if (!(env<bool>("OPS_EXECUTE") ?? false)) {
        println("DRY-RUN: promo_payout_v15 skipped.");
        return;
    }
    if (!(env<string>("OPS_CONFIRM") ?? "").equalTo("YES")) {
        Assert.fail("OPS_CONFIRM=YES required for A9 payout broadcast");
    }
    if (network.equalTo("mainnet") && !(env<string>("OPS_CONFIRM_MAINNET") ?? "").equalTo("YES")) {
        Assert.fail("mainnet A9 payout requires OPS_CONFIRM_MAINNET=YES");
    }

    val hotWallet = scripts.wallet(reqStr("A9_PROMO_HOT_WALLET_NAME"));
    val expectedHot = env<address>("A9_EXPECTED_HOT_WALLET_ADDRESS");
    if (expectedHot != null && hotWallet.address != expectedHot!) {
        Assert.fail(format("hot wallet address mismatch: {} != {}", hotWallet.address, expectedHot!));
    }
    val master = reqAddr("A9_JETTON_MASTER_ADDRESS");
    val recipient = reqAddr("A9_PAYOUT_RECIPIENT");
    val amountRaw = reqInt("A9_PAYOUT_AMOUNT_RAW") as coins;
    val gasNano = (env<int>("A9_PROMO_TRANSFER_GAS_NANO") ?? 50000000) as coins;
    val qid = reqInt("A9_QUERY_ID") as uint64;

    val bal = scripts.fetchAccountBalance(hotWallet.address);
    val minRequired = gasNano + ton("0.05");
    if (bal < minRequired) {
        Assert.fail(format("insufficient hot wallet balance ({} < {})", bal, minRequired));
    }

    val hotJettonWallet = net.runGetMethod<address>(master, "get_wallet_address", [hotWallet.address]);
    if (!scripts.isContractDeployed(hotJettonWallet)) {
        Assert.fail("hot jetton wallet is not deployed yet");
    }
    val hotA9Bal = net.runGetMethod<JettonWalletDataReply>(hotJettonWallet, "get_wallet_data").jettonBalance;
    if (hotA9Bal < amountRaw) {
        Assert.fail(format("insufficient hot wallet A9 inventory ({} < {})", hotA9Bal, amountRaw));
    }
    val body = beginCell()
        .storeUint(OP_JETTON_TRANSFER, 32)
        .storeUint(qid, 64)
        .storeCoins(amountRaw)
        .storeAddress(recipient)
        .storeAddress(hotWallet.address) // CRITICAL: excesses return to hotWallet
        .storeMaybeRef(null)
        .storeCoins(0)
        .storeUint(0, 1)
        .endCell();

    val sent = net.send(hotWallet.address, createMessage({
        bounce: true,
        value: gasNano,
        dest: hotJettonWallet,
        body,
    }));
    val trace = sent.waitForTrace(false, 18, 2500);
    if (trace != null) {
        assertTraceOk(trace!);
        val firstTx = trace!.at(0).tx as cell;
        println("PROMO_PAYOUT_TX=0x{:x}", firstTx.hash());
        return;
    }
    // 多跳 Jetton trace 索引较慢时回退至确认根钱包交易，并由 payout-daemon 通过 TonCenter v3 核验最终下游到账
    val first = sent.waitForFirstTransaction(false, 10, 2500);
    if (first == null) { Assert.fail("promo payout transaction unavailable"); }
    assertSingleTxOk(first!, 0);
    val firstTx = first!.tx as cell;
    println("PROMO_PAYOUT_TX=0x{:x}", firstTx.hash());
}
