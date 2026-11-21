// A9 Protocol v15 — Minimalist round operations script (Acton 1.1.0).
// Supports: open-round | settle-round | abort-round | burn-inactive
import "@acton/env"
import "@stdlib/strings"
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

fun main() {
    val action = reqStr("A9_OP_ACTION");
    val rc = reqAddr("A9_ROUND_CONTROLLER_ADDRESS");
    val signer = scripts.wallet(reqStr("A9_SIGNER_WALLET"));
    val qid = (env<int>("A9_QUERY_ID") ?? 1) as uint64;

    println("=== A9 v15 Round Op: {} ===", action);
    println("RC     = {}", rc);
    println("Signer = {}", signer.address);

    if (!(env<bool>("OPS_EXECUTE") ?? false)) {
        println("DRY-RUN: no on-chain message sent.");
        return;
    }
    if (!(env<string>("OPS_CONFIRM") ?? "").equalTo("YES")) {
        Assert.fail("OPS_CONFIRM=YES required");
    }

    var msg: OutMessage? = null;
    if (action.equalTo("open-round")) {
        msg = createMessage({
            bounce: true,
            value: ton("0.1"),
            dest: rc,
            body: OpenRound {
                queryId: qid,
                twap24hUsdE8: reqInt("A9_TWAP_24H_USD_E8") as uint128,
                targetPriceUsdE8: reqInt("A9_TARGET_PRICE_USD_E8") as uint128,
            },
        });
    } else if (action.equalTo("settle-round")) {
        msg = createMessage({
            bounce: true,
            value: ton("0.3"),
            dest: rc,
            body: SettleRound {
                queryId: qid,
                roundId: reqInt("A9_ROUND_ID") as uint8,
                qualifiedCandles: reqInt("A9_QUALIFIED_CANDLES") as uint8,
                candleHash: reqInt("A9_CANDLE_HASH") as uint256,
            },
        });
    } else if (action.equalTo("abort-round")) {
        msg = createMessage({
            bounce: true,
            value: ton("0.1"),
            dest: rc,
            body: AbortRound { queryId: qid },
        });
    } else if (action.equalTo("burn-inactive")) {
        msg = createMessage({
            bounce: true,
            value: ton("0.22"),
            dest: rc,
            body: BurnInactiveLocked { queryId: qid },
        });
    } else {
        Assert.fail(format("unknown action: {}", action));
    }

    val trace = net.send(signer.address, msg!).waitForTrace();
    if (trace == null) { Assert.fail("trace unavailable"); }
    var i = 0;
    while (i < trace!.size()) {
        val tx = trace!.at(i).tx as cell;
        println("  tx[{}] = 0x{:x}", i, tx.hash());
        i += 1;
    }
    val st = net.runGetMethod<ProtocolStateView>(rc, "get_protocol_state");
    println("State after op: round={} wins={} poolRemaining={} carry={} endAt={}",
        st.currentRoundId, st.successCount, st.poolRemainingRaw, st.carryRaw, st.endAt);
}
