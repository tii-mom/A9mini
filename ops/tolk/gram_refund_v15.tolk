// A9 Protocol v15/v16 — Passive & anomaly GRAM native refund broadcaster (Acton 1.1.0).
// Dry-run by default; real broadcast requires OPS_EXECUTE=true, OPS_CONFIRM=YES,
// and OPS_CONFIRM_MAINNET=YES when targeting mainnet.
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
    if (v == null || v!.calculateLength() == 0) { Assert.fail(format("missing {}", name)); }
    return v!;
}

fun assertSingleTxOk(item: SendResult, idx: int) {
    val rawCell = item.tx as cell;
    println("  tx[{}] = 0x{:x}", idx, rawCell.hash());
    val tx = item.tx.load();
    val descr = tx.description.load();
    if (descr is TlbTransOrd) {
        val c = descr.computePh;
        if (c is TlbTrComputeVm) {
            if (descr.aborted) {
                Assert.fail(format("tx[{}] aborted on-chain", idx));
            }
            val exitCode = c.data.load().exitCode;
            if (exitCode != 0 && exitCode != 1) {
                Assert.fail(format("tx[{}] failed with compute exitCode={}", idx, exitCode));
            }
            val act = descr.action;
            if (!(act is TlbNone)) {
                val actionPh = act.value.load();
                if (!actionPh.success) {
                    Assert.fail(format("tx[{}] action phase failed resultCode={}", idx, actionPh.resultCode));
                }
            }
        } else {
            // 对未部署/未初始化接收方地址的 non-bounceable 普通 GRAM 转账，TON 允许跳过 compute（NoState）并完成入账
            val skip = c.reason;
            if (!(skip is TlbCSkipNoState)) {
                Assert.fail(format("tx[{}] compute phase skipped unexpectedly", idx));
            }
            if (!(descr.bounce is TlbNone)) {
                Assert.fail(format("tx[{}] bounced unexpectedly", idx));
            }
        }
    }
}

fun assertTraceOk(trace: SendResultList) {
    if (trace.size() == 0) { Assert.fail("refund trace is empty"); }
    var i = 0;
    while (i < trace.size()) {
        assertSingleTxOk(trace.at(i), i);
        i += 1;
    }
}

fun buildCommentCell(comment: string): cell {
    var b = beginCell().storeUint(0, 32);
    var s = comment.beginParse();
    if (s.remainingRefsCount() > 0 || s.remainingBitsCount() > 991) {
        Assert.fail("A9_REFUND_MEMO exceeds single-cell 123-byte limit");
    }
    if (s.remainingBitsCount() > 0) {
        b = b.storeSlice(s);
    }
    return b.endCell();
}

fun main() {
    val network = env<string>("A9_NETWORK") ?? "testnet";
    if (!network.equalTo("testnet") && !network.equalTo("mainnet")) {
        Assert.fail("A9_NETWORK must be testnet or mainnet");
    }

    val hotWalletName = reqStr("A9_PRESALE_HOT_WALLET_NAME");
    val hotWallet = scripts.wallet(hotWalletName);
    val recipient = reqAddr("A9_REFUND_RECIPIENT");
    val refundNano = reqInt("A9_REFUND_TON_NANO") as coins;
    val memo = env<string>("A9_REFUND_MEMO") ?? "";
    val bal = scripts.fetchAccountBalance(hotWallet.address);
    val minRequired = refundNano + ton("0.05");

    println("=== A9 GRAM Native Refund ({}) ===", network);
    println("HotWallet  = {}", hotWallet.address);
    println("Balance    = {}", bal);
    println("Recipient  = {}", recipient);
    println("AmountNano = {}", refundNano);
    println("Memo       = {}", memo);

    if (!(env<bool>("OPS_EXECUTE") ?? false)) {
        println("DRY-RUN: gram_refund_v15 skipped.");
        return;
    }
    if (!(env<string>("OPS_CONFIRM") ?? "").equalTo("YES")) {
        Assert.fail("OPS_CONFIRM=YES required for refund broadcast");
    }
    if (network.equalTo("mainnet") && !(env<string>("OPS_CONFIRM_MAINNET") ?? "").equalTo("YES")) {
        Assert.fail("mainnet refund broadcast requires OPS_CONFIRM_MAINNET=YES");
    }
    if (bal < minRequired) {
        Assert.fail(format("insufficient hot wallet balance ({} < {})", bal, minRequired));
    }

    val body = memo.calculateLength() > 0 ? buildCommentCell(memo) : beginCell().endCell();
    val sent = net.send(hotWallet.address, createMessage({
        bounce: false,
        value: refundNano,
        dest: recipient,
        body,
    }));
    val trace = sent.waitForTrace(false, 18, 2500);
    if (trace != null) {
        assertTraceOk(trace!);
        val firstTx = trace!.at(0).tx as cell;
        println("GRAM_REFUND_TX=0x{:x}", firstTx.hash());
        return;
    }
    val first = sent.waitForFirstTransaction(false, 10, 2500);
    if (first == null) { Assert.fail("gram refund transaction unavailable"); }
    assertSingleTxOk(first!, 0);
    val firstTx = first!.tx as cell;
    println("GRAM_REFUND_TX=0x{:x}", firstTx.hash());
}
