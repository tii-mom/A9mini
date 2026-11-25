// A9 Protocol v16.2 — Minimalist round operations script (Acton 1.1.0).
// Supports: open-round | settle-round | abort-round | retry-payouts
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
    if (trace.size() == 0) { Assert.fail("round op trace is empty"); }
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
    val action = reqStr("A9_OP_ACTION");
    val rc = reqAddr("A9_ROUND_CONTROLLER_ADDRESS");
    val signer = scripts.wallet(reqStr("A9_SIGNER_WALLET"));
    val qid = (env<int>("A9_QUERY_ID") ?? 1) as uint64;
    val signerBal = scripts.fetchAccountBalance(signer.address);

    val stBefore = net.runGetMethod<ProtocolStateView>(rc, "get_protocol_state");
    val expectedRoundOpt = env<int>("A9_EXPECTED_ROUND_ID");
    val expectedTargetOpt = env<int>("A9_EXPECTED_TARGET_USD_E8");
    val expectedCloseAtOpt = env<int>("A9_EXPECTED_STAKE_CLOSE_AT");
    var targetRoundForCheck: uint32 = 0;

    if (action.equalTo("open-round")) {
        if (stBefore.endAt != 0) {
            Assert.fail("cannot open-round: protocol reward pool already ended");
        }
        if (expectedRoundOpt != null) {
            val expR = expectedRoundOpt! as uint32;
            if (stBefore.currentRoundId + 1 != expR) {
                Assert.fail(format("open-round mismatch: on-chain currentRoundId={} but expected next={}", stBefore.currentRoundId, expR));
            }
            targetRoundForCheck = expR;
        } else {
            targetRoundForCheck = stBefore.currentRoundId + 1;
        }
    } else if (action.equalTo("settle-round")) {
        val reqRound = reqInt("A9_ROUND_ID") as uint32;
        if (stBefore.currentRoundId != reqRound) {
            Assert.fail(format("settle-round mismatch: on-chain currentRoundId={} != A9_ROUND_ID={}", stBefore.currentRoundId, reqRound));
        }
        val rdBefore = net.runGetMethod<RoundView>(rc, "get_round", [reqRound]);
        if (rdBefore.status != STATUS_ACTIVE) {
            Assert.fail(format("settle-round blocked: round #{} is not ACTIVE (status={})", reqRound, rdBefore.status));
        }
        if (expectedTargetOpt != null && rdBefore.targetPriceUsdE8 != (expectedTargetOpt! as uint128)) {
            Assert.fail(format("settle-round target mismatch: on-chain={} != expected={}", rdBefore.targetPriceUsdE8, expectedTargetOpt!));
        }
        if (expectedCloseAtOpt != null && rdBefore.stakeCloseAt != (expectedCloseAtOpt! as uint64)) {
            Assert.fail(format("settle-round stakeCloseAt mismatch: on-chain={} != expected={}", rdBefore.stakeCloseAt, expectedCloseAtOpt!));
        }
        targetRoundForCheck = reqRound;
    } else if (action.equalTo("abort-round")) {
        if (stBefore.currentRoundId == 0) {
            Assert.fail("cannot abort-round: no round opened on-chain");
        }
        val rdBefore = net.runGetMethod<RoundView>(rc, "get_round", [stBefore.currentRoundId]);
        if (rdBefore.status != STATUS_ACTIVE) {
            Assert.fail(format("abort-round blocked: current round #{} status={}", stBefore.currentRoundId, rdBefore.status));
        }
        targetRoundForCheck = stBefore.currentRoundId;
    }

    println("=== A9 v16 Round Op: {} ({}) ===", action, network);
    println("RC      = {}", rc);
    println("Signer  = {} (balance={})", signer.address, signerBal);
    println("OnChain = round={} wins={} endAt={}", stBefore.currentRoundId, stBefore.successCount, stBefore.endAt);

    if (!(env<bool>("OPS_EXECUTE") ?? false)) {
        println("DRY-RUN: pre-flight on-chain state cross-check OK; no on-chain message sent.");
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
        requiredValue = ton("0.4");
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
    } else if (action.equalTo("retry-payouts")) {
        if (stBefore.pendingTeamReleaseRaw == 0 && stBefore.pendingBurnRaw == 0) {
            Assert.fail("retry-payouts blocked: no pendingTeamReleaseRaw or pendingBurnRaw on-chain");
        }
        requiredValue = ton("0.4");
        msg = createMessage({
            bounce: true,
            value: requiredValue,
            dest: rc,
            body: RetrySettlePayouts { queryId: qid },
        });
    } else {
        Assert.fail(format("unknown action: {}", action));
    }

    val minBal = requiredValue + ton("0.05");
    if (signerBal < minBal) {
        Assert.fail(format("insufficient signer balance ({} < {})", signerBal, minBal));
    }

    val sent = net.send(signer.address, msg!);
    val trace = sent.waitForTrace(false, 12, 2500);
    if (trace != null) {
        assertTraceOk(trace!);
    } else {
        val first = sent.waitForFirstTransaction(false, 15, 2500);
        if (first == null) { Assert.fail("round op transaction unavailable"); }
        assertSingleTxOk(first!, 0);
        val stFallback = net.runGetMethod<ProtocolStateView>(rc, "get_protocol_state");
        if (action.equalTo("open-round") && stFallback.currentRoundId < targetRoundForCheck) {
            Assert.fail(format("open-round fallback verify failed: currentRoundId={} < {}", stFallback.currentRoundId, targetRoundForCheck));
        } else if (action.equalTo("settle-round")) {
            val rdAfter = net.runGetMethod<RoundView>(rc, "get_round", [targetRoundForCheck]);
            if (rdAfter.status != STATUS_SUCCEEDED && rdAfter.status != STATUS_FAILED) {
                Assert.fail(format("settle-round fallback verify failed: round #{} still status={}", targetRoundForCheck, rdAfter.status));
            }
        } else if (action.equalTo("abort-round")) {
            val rdAfter = net.runGetMethod<RoundView>(rc, "get_round", [targetRoundForCheck]);
            if (rdAfter.status != STATUS_ABORTED) {
                Assert.fail(format("abort-round fallback verify failed: round #{} status={}", targetRoundForCheck, rdAfter.status));
            }
        }
    }
    val st = net.runGetMethod<ProtocolStateView>(rc, "get_protocol_state");
    println("State after op: round={} wins={} poolRemaining={} carry={} endAt={}",
        st.currentRoundId, st.successCount, st.poolRemainingRaw, st.carryRaw, st.endAt);
}
