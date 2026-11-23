// A9 Protocol v16 — Minimalist round operations script (Acton 1.1.0).
// Supports: open-round | settle-round | abort-round | burn-inactive
import "@acton/env"
import "@stdlib/strings"
import "@acton/testing/assert"
import "@acton/tlb/maybe"
import "@acton/types/transaction"
import "@acton/types/big_array"
import "@acton/emulation/network"
import "@acton/io"
import "@acton/fmt"
import "@acton/emulation/scripts"
import "@contracts/types"

fun reqInt(name: string): int {
    val v = env<int>(name);
    if (v == null || v! < 0) { Assert.fail(format("missing {}", name)); }
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

fun assertTraceOk(trace: SendResultList) {
    if (trace.size() == 0) { Assert.fail("round op trace is empty"); }
    var i = 0;
    while (i < trace.size()) {
        val rawCell = trace.at(i).tx as cell;
        println("  tx[{}] = 0x{:x}", i, rawCell.hash());
        val tx = trace.at(i).tx.load();
        val descr = tx.description.load();
        if (descr is TlbTransOrd) {
            if (descr.aborted) {
                Assert.fail(format("tx[{}] aborted on-chain", i));
            }
            val c = descr.computePh;
            if (c is TlbTrComputeVm) {
                val exitCode = c.data.load().exitCode;
                if (exitCode != 0 && exitCode != 1) {
                    Assert.fail(format("tx[{}] failed compute exitCode={}", i, exitCode));
                }
            }
            val act = descr.action;
            if (!(act is TlbNone)) {
                val actionPh = act.value.load();
                if (!actionPh.success) {
                    Assert.fail(format("tx[{}] failed action resultCode={}", i, actionPh.resultCode));
                }
            }
        }
        i += 1;
    }
}

fun main() {
    val network = env<string>("A9_NETWORK") ?? "testnet";
    if (!network.equalTo("testnet") && !network.equalTo("mainnet")) {
        Assert.fail("A9_NETWORK must be testnet or mainnet");
    }
    val action = reqStr("A9_OP_ACTION");
    val rc = reqAddr("A9_ROUND_CONTROLLER_ADDRESS");
    val signer = scripts.wallet(reqStr("A9_SIGNER_WALLET"));
    val qid = (env<int>("A9_QUERY_ID") ?? 1) as uint64;
    val signerBal = scripts.fetchAccountBalance(signer.address);

    println("=== A9 v16 Round Op: {} ({}) ===", action, network);
    println("RC      = {}", rc);
    println("Signer  = {} (balance={})", signer.address, signerBal);

    if (!(env<bool>("OPS_EXECUTE") ?? false)) {
        println("DRY-RUN: no on-chain message sent.");
        return;
    }
    if (!(env<string>("OPS_CONFIRM") ?? "").equalTo("YES")) {
        Assert.fail("OPS_CONFIRM=YES required");
    }
    if (network.equalTo("mainnet") && !(env<string>("OPS_CONFIRM_MAINNET") ?? "").equalTo("YES")) {
        Assert.fail("mainnet round op requires OPS_CONFIRM_MAINNET=YES");
    }

    var msg: OutMessage? = null;
    var requiredValue: coins = ton("0.1");
    if (action.equalTo("open-round")) {
        requiredValue = ton("0.1");
        msg = createMessage({
            bounce: true,
            value: requiredValue,
            dest: rc,
            body: OpenRound {
                queryId: qid,
                twap24hUsdE8: reqInt("A9_TWAP_24H_USD_E8") as uint128,
                targetPriceUsdE8: reqInt("A9_TARGET_PRICE_USD_E8") as uint128,
            },
        });
    } else if (action.equalTo("settle-round")) {
        requiredValue = ton("0.3");
        msg = createMessage({
            bounce: true,
            value: requiredValue,
            dest: rc,
            body: SettleRound {
                queryId: qid,
                roundId: reqInt("A9_ROUND_ID") as uint32,
                qualifiedCandles: reqInt("A9_QUALIFIED_CANDLES") as uint8,
                candleHash: reqInt("A9_CANDLE_HASH") as uint256,
            },
        });
    } else if (action.equalTo("abort-round")) {
        requiredValue = ton("0.1");
        msg = createMessage({
            bounce: true,
            value: requiredValue,
            dest: rc,
            body: AbortRound { queryId: qid },
        });
    } else if (action.equalTo("burn-inactive")) {
        requiredValue = ton("0.22");
        msg = createMessage({
            bounce: true,
            value: requiredValue,
            dest: rc,
            body: BurnInactiveLocked { queryId: qid },
        });
    } else {
        Assert.fail(format("unknown action: {}", action));
    }

    val minBal = requiredValue + ton("0.05");
    if (signerBal < minBal) {
        Assert.fail(format("insufficient signer balance ({} < {})", signerBal, minBal));
    }

    val trace = net.send(signer.address, msg!).waitForTrace();
    if (trace == null) { Assert.fail("trace unavailable"); }
    assertTraceOk(trace!);
    val st = net.runGetMethod<ProtocolStateView>(rc, "get_protocol_state");
    println("State after op: round={} wins={} poolRemaining={} carry={} endAt={}",
        st.currentRoundId, st.successCount, st.poolRemainingRaw, st.carryRaw, st.endAt);
}
