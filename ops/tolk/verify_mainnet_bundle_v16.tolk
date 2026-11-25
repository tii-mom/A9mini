// A9 v16.2 — 离线 TVM 沙盒逐位交叉验真：直接执行 @ton/core 生成的 5 笔主网扫码交易 BOC
import "@stdlib/strings"
import "@acton/env"
import "@acton/build"
import "@acton/fmt"
import "@acton/io"
import "@acton/testing/assert"
import "@acton/emulation/testing"
import "@acton/emulation/network"
import "@acton/tlb/maybe"
import "@acton/types/big_array"
import "@acton/types/transaction"
import "@contracts/types"
import "@contracts/jetton/storage"

fun reqEnvStr(name: string): string {
    val v = env<string>(name);
    if (v == null || v!.calculateLength() == 0) {
        Assert.fail(format("missing env {}", name));
    }
    return v!;
}

fun assertSuccessTx(txs: SendResultList, label: string) {
    if (txs.size() == 0) {
        Assert.fail(format("{}: no transactions executed", label));
    }
    var i = 0;
    while (i < txs.size()) {
        val tx = txs.at(i).tx.load();
        val descr = tx.description.load();
        if (descr is TlbTransOrd) {
            val c = descr.computePh;
            if (c is TlbTrComputeVm) {
                val ec = c.data.load().exitCode;
                if (ec != 0 && ec != 1) {
                    Assert.fail(format("{}: tx[{}] compute exitCode={}", label, i, ec));
                }
                if (descr.aborted) {
                    Assert.fail(format("{}: tx[{}] aborted", label, i));
                }
            } else {
                val skip = c.reason;
                if (!(skip is TlbCSkipNoState) || !(descr.bounce is TlbNone)) {
                    Assert.fail(format("{}: tx[{}] compute skipped unexpectedly", label, i));
                }
            }
            val a = descr.action;
            if (!(a is TlbNone)) {
                val act = a.value.load();
                if (!act.success) {
                    Assert.fail(format("{}: tx[{}] action failed resultCode={}", label, i, act.resultCode));
                }
            }
        }
        i += 1;
    }
}

fun main() {
    val deployer = parseAddress(reqEnvStr("A9_V_DEPLOYER"));
    val treasury = parseAddress(reqEnvStr("A9_V_TREASURY"));
    val keeper = parseAddress(reqEnvStr("A9_V_KEEPER"));
    val teamWallet = parseAddress(reqEnvStr("A9_V_TEAM"));

    val expMaster = parseAddress(reqEnvStr("A9_V_MASTER_ADDR"));
    val expRc = parseAddress(reqEnvStr("A9_V_RC_ADDR"));
    val expTreasuryJw = parseAddress(reqEnvStr("A9_V_TREASURY_JW"));
    val expRcJw = parseAddress(reqEnvStr("A9_V_RC_JW"));

    val masterInitCell = parseCellFromBase64(reqEnvStr("A9_V_MASTER_INIT_B64"));
    val rcInitCell = parseCellFromBase64(reqEnvStr("A9_V_RC_INIT_B64"));
    val topUpBody = parseCellFromBase64(reqEnvStr("A9_V_TOPUP_B64"));
    val mintBody = parseCellFromBase64(reqEnvStr("A9_V_MINT_B64"));
    val dropBody = parseCellFromBase64(reqEnvStr("A9_V_DROP_B64"));
    val fundBody = parseCellFromBase64(reqEnvStr("A9_V_FUND_B64"));

    // 1. 核对 Tolk 原生构造的 MasterStorage & Storage 地址是否与 @ton/core 100% 逐位一致
    val masterCode = build("JettonMaster");
    val walletCode = build("JettonWallet");
    val rcCode = build("RoundController");
    val ticketCode = build("StakeTicket");

    var metadata: OnchainMetadataReply = { contentDict: [] };
    metadata.contentDict.set("uri".sha256(), "https://app.a9.lat/a9.json".prefixWith00());
    val nativeMasterInit = ContractState {
        code: masterCode,
        data: MasterStorage {
            totalSupply: 0,
            adminAddress: treasury,
            nextAdminAddress: null,
            metadata: metadata.toCell(),
        }.toCell(),
    };
    val nativeMasterAddr = AutoDeployAddress { stateInit: nativeMasterInit }.calculateAddress();
    Assert.equal(nativeMasterAddr, expMaster, "JettonMaster address mismatch vs Tolk native");

    val cfg = ProtocolConfig {
        keeper,
        roundOpener: keeper,
        jettonMaster: nativeMasterAddr,
        econ: ProtocolEcon {
            teamWallet,
            p0UsdE8: 116000,
            roundRewardRaw: 700_000_000_000_000_000,
            teamRoundRaw: 120_000_000_000_000_000,
            minStakeRaw: 1_000_000_000_000,
        }.toCell(),
        timing: ProtocolTiming {
            stakeDurationSeconds: 129600,
            observationSeconds: 86400,
            candleCount: 24,
            minQualifiedCandles: 16,
            abortTimeoutSeconds: 604800,
            vestingSeconds: 3456000,
        }.toCell(),
        codes: ProtocolCodes { jettonWalletCode: walletCode, ticketCode }.toCell(),
    };
    val nativeRcInit = ContractState {
        code: rcCode,
        data: Storage {
            config: cfg.toCell(),
            rounds: [],
            currentRoundId: 0,
            successCount: 0,
            poolRemainingRaw: 7_000_000_000_000_000_000,
            carryRaw: 0,
            teamPoolRemainingRaw: 1_200_000_000_000_000_000,
            teamCarryRaw: 0,
            lastSuccessAt: 0,
            endAt: 0,
            pendingTeamReleaseRaw: 0,
            pendingBurnRaw: 0,
        }.toCell(),
    };
    val nativeRcAddr = AutoDeployAddress { stateInit: nativeRcInit }.calculateAddress();
    Assert.equal(nativeRcAddr, expRc, "RoundController address mismatch vs Tolk native");

    // 2. 在本地 TVM 沙盒里，1:1 使用 @ton/core 生成的 Base64 BOC 执行全部 5 步！
    val masterInitParsed = StateInit.fromCell(masterInitCell);
    val rcInitParsed = StateInit.fromCell(rcInitCell);

    // Step 1: deployer deploys JettonMaster with 0.20 TON
    val r1 = net.send(deployer, createMessage({
        bounce: false,
        value: ton("0.20"),
        dest: { stateInit: { code: masterInitParsed.code!, data: masterInitParsed.data! } },
        body: topUpBody,
    }));
    assertSuccessTx(r1, "step1-deploy-master");

    val onchainTreasuryJw = net.runGetMethod<address>(expMaster, "get_wallet_address", [treasury]);
    val onchainRcJw = net.runGetMethod<address>(expMaster, "get_wallet_address", [expRc]);
    Assert.equal(onchainTreasuryJw, expTreasuryJw, "treasuryJettonWallet mismatch vs on-chain get_wallet_address");
    Assert.equal(onchainRcJw, expRcJw, "rcJettonWallet mismatch vs on-chain get_wallet_address");

    // Step 2: treasury MintOnce 10B A9 with 0.35 TON
    val r2 = net.send(treasury, createMessage({
        bounce: true,
        value: ton("0.35"),
        dest: expMaster,
        body: mintBody,
    }));
    assertSuccessTx(r2, "step2-mint-once");
    val twAfterMint = net.runGetMethod<JettonWalletDataReply>(expTreasuryJw, "get_wallet_data").jettonBalance;
    Assert.equal(twAfterMint, 10_000_000_000_000_000_000, "treasury must hold 10B A9 after step 2");

    // Step 3: treasury DropMinterAdmin with 0.06 TON
    val r3 = net.send(treasury, createMessage({
        bounce: true,
        value: ton("0.06"),
        dest: expMaster,
        body: dropBody,
    }));
    assertSuccessTx(r3, "step3-drop-admin");
    val jmData = net.runGetMethod<JettonDataReply>(expMaster, "get_jetton_data");
    Assert.equal(jmData.totalSupply, 10_000_000_000_000_000_000, "totalSupply must be 10B");
    Assert.equal(jmData.mintable, false, "mintable must be false");
    Assert.equal(jmData.adminAddress == null, true, "adminAddress must be null");

    // Step 4: deployer deploys RoundController with 0.70 TON
    val r4 = net.send(deployer, createMessage({
        bounce: false,
        value: ton("0.70"),
        dest: { stateInit: { code: rcInitParsed.code!, data: rcInitParsed.data! } },
        body: topUpBody,
    }));
    assertSuccessTx(r4, "step4-deploy-rc");
    val rcJwFromRc = net.runGetMethod<address>(expRc, "get_jetton_wallet_address");
    Assert.equal(rcJwFromRc, expRcJw, "RoundController jetton wallet address mismatch");

    // Step 5: treasury funds RoundController with 8.2B A9 (0.20 TON)
    val r5 = net.send(treasury, createMessage({
        bounce: true,
        value: ton("0.20"),
        dest: expTreasuryJw,
        body: fundBody,
    }));
    println("r5 txs={}, rcBal={}, twBal={}", r5.size(),
        net.runGetMethod<JettonWalletDataReply>(expRcJw, "get_wallet_data").jettonBalance,
        net.runGetMethod<JettonWalletDataReply>(expTreasuryJw, "get_wallet_data").jettonBalance);
    assertSuccessTx(r5, "step5-fund-rc");

    val rcBal = net.runGetMethod<JettonWalletDataReply>(expRcJw, "get_wallet_data").jettonBalance;
    val twBal = net.runGetMethod<JettonWalletDataReply>(expTreasuryJw, "get_wallet_data").jettonBalance;
    val ps = net.runGetMethod<ProtocolStateView>(expRc, "get_protocol_state");
    Assert.equal(rcBal, 8_200_000_000_000_000_000, "RC wallet must hold 8.2B A9");
    Assert.equal(twBal, 1_800_000_000_000_000_000, "Treasury wallet must retain 1.8B A9");
    Assert.equal(ps.currentRoundId, 0, "currentRoundId must be 0");
    Assert.equal(ps.poolRemainingRaw, 7_000_000_000_000_000_000, "poolRemainingRaw must be 7B");
    Assert.equal(ps.teamPoolRemainingRaw, 1_200_000_000_000_000_000, "teamPoolRemainingRaw must be 1.2B");

    println("BUNDLE_TVM_SANDBOX_VERIFIED_OK");
}
