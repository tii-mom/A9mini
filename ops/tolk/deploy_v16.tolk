// A9 Protocol v16 — Minimalist 4-contract deployment script with 4-step idempotent resume (Acton 1.1.0).
// Run from A9mini/v16 via ops/scripts/deploy-v15.mjs --protocol v16 (default dry-run).
import "@stdlib/strings"
import "@acton/env"
import "@acton/testing/assert"
import "@acton/tlb/maybe"
import "@acton/types/transaction"
import "@acton/types/big_array"
import "@acton/build"
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

fun sendAndVerify(from: address, msg: OutMessage, label: string) {
    val trace = net.send(from, msg).waitForTrace(false, 25, 3000);
    if (trace == null || trace!.size() == 0) {
        Assert.fail(format("{}: trace unavailable; check explorer before retry", label));
    }
    var i = 0;
    while (i < trace!.size()) {
        val rawCell = trace!.at(i).tx as cell;
        println("  tx[{}] = 0x{:x}", i, rawCell.hash());
        val tx = trace!.at(i).tx.load();
        val descr = tx.description.load();
        if (descr is TlbTransOrd) {
            if (descr.aborted) {
                Assert.fail(format("{}: tx[{}] aborted on-chain", label, i));
            }
            val c = descr.computePh;
            if (c is TlbTrComputeVm) {
                val exitCode = c.data.load().exitCode;
                if (exitCode != 0 && exitCode != 1) {
                    Assert.fail(format("{}: tx[{}] failed compute exitCode={}", label, i, exitCode));
                }
            } else {
                val skip = c.reason;
                if (!(skip is TlbCSkipNoState) || !(descr.bounce is TlbNone)) {
                    Assert.fail(format("{}: tx[{}] compute skipped unexpectedly", label, i));
                }
            }
            val act = descr.action;
            if (!(act is TlbNone)) {
                val actionPh = act.value.load();
                if (!actionPh.success) {
                    Assert.fail(format("{}: tx[{}] failed action resultCode={}", label, i, actionPh.resultCode));
                }
            }
        }
        i += 1;
    }
}

fun main() {
    val network = reqStr("A9_NETWORK");
    if (!network.equalTo("testnet") && !network.equalTo("mainnet")) {
        Assert.fail("A9_NETWORK must be testnet or mainnet");
    }

    val deployer = scripts.wallet(reqStr("A9_DEPLOY_WALLET"));
    val treasury = scripts.wallet(reqStr("A9_TREASURY_WALLET"));
    val keeper = reqAddr("A9_KEEPER_ADDRESS");
    val roundOpener = env<address>("A9_ROUND_OPENER_ADDRESS") ?? keeper;
    val teamWallet = reqAddr("A9_TEAM_WALLET_ADDRESS");
    if (deployer.address.getWorkchain() != BASECHAIN || treasury.address.getWorkchain() != BASECHAIN) {
        Assert.fail("deployer and treasury wallets must reside on Basechain (workchain 0)");
    }
    if (keeper.getWorkchain() != BASECHAIN || roundOpener.getWorkchain() != BASECHAIN || teamWallet.getWorkchain() != BASECHAIN) {
        Assert.fail("keeper, roundOpener, and teamWallet must reside on Basechain (workchain 0)");
    }

    val masterCode = build("JettonMaster");
    val walletCode = build("JettonWallet");
    val controllerCode = build("RoundController");
    val ticketCode = build("StakeTicket");

    val totalSupply = reqInt("A9_TOTAL_SUPPLY_RAW") as coins;
    val rewardPool = reqInt("A9_REWARD_POOL_RAW") as uint128;
    val teamPool = reqInt("A9_TEAM_POOL_RAW") as uint128;
    val rcFunding = reqInt("A9_RC_FUNDING_RAW") as coins;
    val tonMaster = reqInt("A9_TON_MASTER") as coins;
    val mintTotal = reqInt("A9_TON_MINT_TOTAL") as coins;
    val mintFwd = reqInt("A9_TON_MINT_FORWARD") as coins;
    val tonRc = reqInt("A9_TON_RC") as coins;
    val tonFunding = reqInt("A9_TON_FUNDING") as coins;

    val metadataUri = reqStr("A9_METADATA_URI");
    if (metadataUri.calculateLength() == 0) {
        Assert.fail("A9_METADATA_URI must not be empty");
    }
    var metadata: OnchainMetadataReply = { contentDict: [] };
    metadata.contentDict.set("uri".sha256(), metadataUri.prefixWith00());
    val masterInit = ContractState {
        code: masterCode,
        data: MasterStorage {
            totalSupply: 0,
            adminAddress: treasury.address,
            nextAdminAddress: null,
            metadata: metadata.toCell(),
        }.toCell(),
    };
    val master = AutoDeployAddress { stateInit: masterInit }.calculateAddress();

    val cfg = ProtocolConfig {
        keeper,
        roundOpener,
        jettonMaster: master,
        econ: ProtocolEcon {
            teamWallet,
            p0UsdE8: reqInt("A9_P0_USD_E8") as uint128,
            roundRewardRaw: reqInt("A9_ROUND_REWARD_RAW") as uint128,
            teamRoundRaw: reqInt("A9_TEAM_ROUND_RAW") as uint128,
            minStakeRaw: reqInt("A9_MIN_STAKE_RAW") as uint128,
        }.toCell(),
        timing: ProtocolTiming {
            stakeDurationSeconds: reqInt("A9_STAKE_SECONDS") as uint32,
            observationSeconds: reqInt("A9_OBS_SECONDS") as uint32,
            candleCount: reqInt("A9_CANDLE_COUNT") as uint8,
            minQualifiedCandles: reqInt("A9_MIN_QUALIFIED") as uint8,
            abortTimeoutSeconds: reqInt("A9_ABORT_TIMEOUT_SECONDS") as uint32,
            vestingSeconds: reqInt("A9_VESTING_SECONDS") as uint32,
        }.toCell(),
        codes: ProtocolCodes { jettonWalletCode: walletCode, ticketCode }.toCell(),
    };

    val controllerInit = ContractState {
        code: controllerCode,
        data: Storage {
            config: cfg.toCell(),
            rounds: [],
            currentRoundId: 0,
            successCount: 0,
            poolRemainingRaw: rewardPool,
            carryRaw: 0,
            teamPoolRemainingRaw: teamPool,
            teamCarryRaw: 0,
            lastSuccessAt: 0,
            endAt: 0,
            pendingTeamReleaseRaw: 0,
            pendingBurnRaw: 0,
        }.toCell(),
    };
    val controller = AutoDeployAddress { stateInit: controllerInit }.calculateAddress();

    val masterDeployed = scripts.isContractDeployed(master);
    val controllerDeployed = scripts.isContractDeployed(controller);
    val deployerBal = scripts.fetchAccountBalance(deployer.address);
    val treasuryBal = scripts.fetchAccountBalance(treasury.address);

    println("=== A9 v16 Deployment Plan ({}) ===", network);
    println("JettonMaster    = {} (deployed={})", master, masterDeployed);
    println("RoundController = {} (deployed={})", controller, controllerDeployed);
    println("Deployer        = {} (balance={})", deployer.address, deployerBal);
    println("Treasury        = {} (balance={})", treasury.address, treasuryBal);
    println("RoundOpener     = {}", roundOpener);
    println("Keeper          = {}", keeper);
    println("TeamWallet      = {}", teamWallet);

    if (!(env<bool>("OPS_EXECUTE") ?? false)) {
        println("DRY-RUN: no on-chain messages sent.");
        return;
    }
    if (!(env<string>("OPS_CONFIRM") ?? "").equalTo("YES")) {
        Assert.fail("OPS_CONFIRM=YES required for execution");
    }
    if (network.equalTo("mainnet") && !(env<string>("OPS_CONFIRM_MAINNET") ?? "").equalTo("YES")) {
        Assert.fail("mainnet requires OPS_CONFIRM_MAINNET=YES");
    }

    // 1. Deploy JettonMaster (idempotent resume)
    if (masterDeployed) {
        val existingMaster = net.runGetMethod<JettonDataReply>(master, "get_jetton_data");
        val okUnminted = existingMaster.totalSupply == 0 && existingMaster.mintable && existingMaster.adminAddress != null && existingMaster.adminAddress! == treasury.address;
        val okMinted = existingMaster.totalSupply == totalSupply && !existingMaster.mintable;
        if (!okUnminted && !okMinted) {
            Assert.fail("JettonMaster already deployed with unexpected supply/admin state");
        }
        println("[1/4] SKIP: JettonMaster already deployed and verified.");
    } else {
        val needDeployer = tonMaster + ton("0.1");
        if (scripts.fetchAccountBalance(deployer.address) < needDeployer) {
            Assert.fail(format("insufficient deployer balance for JettonMaster (need >= {})", needDeployer));
        }
        println("[1/4] Deploying JettonMaster...");
        sendAndVerify(deployer.address, createMessage({
            bounce: false,
            value: tonMaster,
            dest: { stateInit: masterInit },
            body: TopUpTons {},
        }), "step1-deploy-master");
    }

    // 2. Mint 10B A9 once -> verify treasury received 10B -> DropMinterAdmin permanently (P0-1 idempotent resume)
    val mBefore = net.runGetMethod<JettonDataReply>(master, "get_jetton_data");
    if (mBefore.totalSupply == totalSupply && mBefore.adminAddress == null && !mBefore.mintable) {
        println("[2/4] SKIP: 10B A9 already minted and admin permanently renounced.");
    } else if (mBefore.totalSupply == 0 && mBefore.mintable && mBefore.adminAddress != null && mBefore.adminAddress! == treasury.address) {
        val needTreasury = mintTotal + ton("0.15");
        if (scripts.fetchAccountBalance(treasury.address) < needTreasury) {
            Assert.fail(format("insufficient treasury balance for MintOnce + DropMinterAdmin (need >= {})", needTreasury));
        }
        if (mintTotal < mintFwd + ton("0.10")) {
            Assert.fail("A9_TON_MINT_TOTAL must exceed A9_TON_MINT_FORWARD by >= 0.10 GRAM");
        }
        val mintMsgTotal = mintFwd + ton("0.05");
        println("[2/4] Minting 10B A9 once to treasury...");
        val mintBody = beginCell()
            .storeUint(0x00000015, 32)
            .storeUint(1, 64)
            .storeAddress(treasury.address)
            .storeCoins(mintFwd)
            .storeCoins(totalSupply)
            .storeCoins(mintMsgTotal)
            .storeUint(0, 1)
            .endCell();
        sendAndVerify(treasury.address, createMessage({ bounce: true, value: mintTotal, dest: master, body: mintBody }), "step2a-mint-once");
    } else if (mBefore.totalSupply == totalSupply && mBefore.adminAddress != null && mBefore.adminAddress! == treasury.address) {
        println("[2/4] 10B A9 already minted; proceeding to permanent DropMinterAdmin...");
    } else {
        Assert.fail("unexpected JettonMaster state before MintOnce");
    }

    // Verify treasuryWallet holds minted supply before permanently renouncing admin
    val treasuryWallet = net.runGetMethod<address>(master, "get_wallet_address", [treasury.address]);
    val mMid = net.runGetMethod<JettonDataReply>(master, "get_jetton_data");
    if (mMid.totalSupply != totalSupply || mMid.mintable) {
        Assert.fail("mint-once supply verification failed");
    }
    if (mMid.adminAddress != null) {
        if (mMid.adminAddress! != treasury.address) {
            Assert.fail("JettonMaster admin does not match treasury wallet before DropMinterAdmin");
        }
        val twBal = net.runGetMethod<JettonWalletDataReply>(treasuryWallet, "get_wallet_data").jettonBalance;
        if (twBal == 0) {
            Assert.fail("treasury JettonWallet balance is 0 after MintOnce; refusing to drop admin");
        }
        println("[2/4] Treasury JettonWallet verified ({}); sending permanent DropMinterAdmin...", twBal);
        sendAndVerify(treasury.address, createMessage({
            bounce: true,
            value: ton("0.05"),
            dest: master,
            body: DropMinterAdmin { queryId: 2 },
        }), "step2b-drop-admin");
    }

    val mData = net.runGetMethod<JettonDataReply>(master, "get_jetton_data");
    if (mData.totalSupply != totalSupply || mData.mintable || mData.adminAddress != null) {
        Assert.fail("mint-once + admin renouncement verification failed");
    }

    // 3. Deploy RoundController (idempotent resume)
    val rcWallet = net.runGetMethod<address>(master, "get_wallet_address", [controller]);
    if (controllerDeployed) {
        if (net.runGetMethod<address>(controller, "get_jetton_wallet_address") != rcWallet) {
            Assert.fail("existing RoundController jetton wallet address mismatch");
        }
        println("[3/4] SKIP: RoundController already deployed and verified.");
    } else {
        val needDeployerRc = tonRc + ton("0.1");
        if (scripts.fetchAccountBalance(deployer.address) < needDeployerRc) {
            Assert.fail(format("insufficient deployer balance for RoundController (need >= {})", needDeployerRc));
        }
        println("[3/4] Deploying RoundController...");
        sendAndVerify(deployer.address, createMessage({
            bounce: false,
            value: tonRc,
            dest: { stateInit: controllerInit },
            body: TopUpTons {},
        }), "step3-deploy-rc");
    }

    // 4. Fund RoundController with 8.2B A9 (forward_ton_amount = 0, idempotent resume)
    if (net.runGetMethod<address>(controller, "get_jetton_wallet_address") != rcWallet) {
        Assert.fail("RoundController jetton wallet address mismatch");
    }
    var rcBalBefore: coins = 0;
    if (scripts.isContractDeployed(rcWallet)) {
        rcBalBefore = net.runGetMethod<JettonWalletDataReply>(rcWallet, "get_wallet_data").jettonBalance;
    }

    if (rcBalBefore == rcFunding) {
        println("[4/4] SKIP: RoundController already funded with 8.2B A9.");
    } else if (rcBalBefore == 0) {
        val needTreasuryFund = tonFunding + ton("0.1");
        if (scripts.fetchAccountBalance(treasury.address) < needTreasuryFund) {
            Assert.fail(format("insufficient treasury balance for RC funding (need >= {})", needTreasuryFund));
        }
        val treasuryA9Before = net.runGetMethod<JettonWalletDataReply>(treasuryWallet, "get_wallet_data").jettonBalance;
        if (treasuryA9Before < rcFunding) {
            Assert.fail(format("insufficient treasury A9 balance ({} < {})", treasuryA9Before, rcFunding));
        }
        println("[4/4] Funding RoundController with 8.2B A9...");
        val transferBody = beginCell()
            .storeUint(OP_JETTON_TRANSFER, 32)
            .storeUint(2, 64)
            .storeCoins(rcFunding)
            .storeAddress(controller)
            .storeAddress(treasury.address)
            .storeMaybeRef(null)
            .storeCoins(0)
            .storeUint(0, 1)
            .endCell();
        sendAndVerify(treasury.address, createMessage({
            bounce: true,
            value: tonFunding,
            dest: treasuryWallet,
            body: transferBody,
        }), "step4-fund-rc");
    } else {
        Assert.fail(format("unexpected RoundController A9 balance before funding: {}", rcBalBefore));
    }

    val rcBal = net.runGetMethod<JettonWalletDataReply>(rcWallet, "get_wallet_data").jettonBalance;
    val treasuryA9After = net.runGetMethod<JettonWalletDataReply>(treasuryWallet, "get_wallet_data").jettonBalance;
    if (rcBal != rcFunding) { Assert.fail("RC funding balance mismatch"); }
    if (rcBal + treasuryA9After > totalSupply) { Assert.fail("supply conservation violated"); }

    println("=== A9 v16 Deployed & Verified ===");
    println("A9_JETTON_MASTER_ADDRESS={}", master);
    println("A9_ROUND_CONTROLLER_ADDRESS={}", controller);
    println("RC_JETTON_WALLET={}", rcWallet);
    println("RC_A9_BALANCE_RAW={}", rcBal);
    println("TREASURY_A9_BALANCE_RAW={}", treasuryA9After);
}
