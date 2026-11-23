// A9 Protocol v15 — Minimalist 4-contract deployment script (Acton 1.1.0).
// Run from A9mini/v15 via ops/scripts/deploy-v15.mjs (default dry-run).
import "@stdlib/strings"
import "@acton/env"
import "@stdlib/strings"
import "@acton/testing/assert"
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

fun sendAndLog(from: address, msg: OutMessage) {
    val trace = net.send(from, msg).waitForTrace();
    if (trace == null) { Assert.fail("trace unavailable; check explorer before retry"); }
    var i = 0;
    while (i < trace!.size()) {
        val tx = trace!.at(i).tx as cell;
        println("  tx[{}] = 0x{:x}", i, tx.hash());
        i += 1;
    }
}

fun main() {
    val network = reqStr("A9_NETWORK");
    if (!network.equalTo("testnet") && !network.equalTo("mainnet")) {
        Assert.fail("A9_NETWORK must be testnet or mainnet");
    }
    if (network.equalTo("mainnet") && !(env<string>("OPS_CONFIRM_MAINNET") ?? "").equalTo("YES")) {
        Assert.fail("mainnet requires OPS_CONFIRM_MAINNET=YES");
    }

    val deployer = scripts.wallet(reqStr("A9_DEPLOY_WALLET"));
    val treasury = scripts.wallet(reqStr("A9_TREASURY_WALLET"));
    val keeper = reqAddr("A9_KEEPER_ADDRESS");
    val roundOpener = env<address>("A9_ROUND_OPENER_ADDRESS") ?? keeper;
    val teamWallet = reqAddr("A9_TEAM_WALLET_ADDRESS");

    val masterCode = build("JettonMaster");
    val walletCode = build("JettonWallet");
    val controllerCode = build("RoundController");
    val ticketCode = build("StakeTicket");

    val totalSupply = reqInt("A9_TOTAL_SUPPLY_RAW") as coins;
    val rewardPool = reqInt("A9_REWARD_POOL_RAW") as uint128;
    val teamPool = reqInt("A9_TEAM_POOL_RAW") as uint128;
    val rcFunding = reqInt("A9_RC_FUNDING_RAW") as coins;

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
            fallbackUnlockSeconds: reqInt("A9_FALLBACK_UNLOCK_SECONDS") as uint32,
            inactivityBurnSeconds: reqInt("A9_INACTIVITY_BURN_SECONDS") as uint32,
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
            activeLockedRounds: 0,
        }.toCell(),
    };
    val controller = AutoDeployAddress { stateInit: controllerInit }.calculateAddress();

    println("=== A9 {} Deployment Plan ({}) ===", env<string>("A9_PROTOCOL_VERSION") ?? "v15", network);
    println("JettonMaster    = {}", master);
    println("RoundController = {}", controller);
    println("Deployer        = {}", deployer.address);
    println("Treasury        = {}", treasury.address);
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
    if (scripts.isContractDeployed(master) || scripts.isContractDeployed(controller)) {
        Assert.fail("target contract address is already deployed");
    }

    // 1. Deploy JettonMaster
    println("[1/4] Deploying JettonMaster...");
    sendAndLog(deployer.address, createMessage({
        bounce: false,
        value: reqInt("A9_TON_MASTER") as coins,
        dest: { stateInit: masterInit },
        body: TopUpTons {},
    }));

    // 2. Mint 10B A9 once -> permanently drop admin
    println("[2/4] Minting 10B A9 once and renouncing admin...");
    val mintTotal = reqInt("A9_TON_MINT_TOTAL") as coins;
    val mintFwd = reqInt("A9_TON_MINT_FORWARD") as coins;
    val mintBody = beginCell()
        .storeUint(0x00000015, 32)
        .storeUint(1, 64)
        .storeAddress(treasury.address)
        .storeCoins(mintFwd)
        .storeCoins(totalSupply)
        .storeCoins(mintTotal)
        .storeUint(0, 1)
        .endCell();
    sendAndLog(treasury.address, createMessage({ bounce: true, value: mintTotal, dest: master, body: mintBody }));

    val mData = net.runGetMethod<JettonDataReply>(master, "get_jetton_data");
    if (mData.totalSupply != totalSupply || mData.mintable) {
        Assert.fail("mint-once verification failed");
    }

    // 3. Deploy RoundController
    println("[3/4] Deploying RoundController...");
    sendAndLog(deployer.address, createMessage({
        bounce: false,
        value: reqInt("A9_TON_RC") as coins,
        dest: { stateInit: controllerInit },
        body: TopUpTons {},
    }));

    // 4. Fund RoundController with 8.2B A9 (forward_ton_amount = 0)
    println("[4/4] Funding RoundController with 8.2B A9...");
    val treasuryWallet = net.runGetMethod<address>(master, "get_wallet_address", [treasury.address]);
    val rcWallet = net.runGetMethod<address>(master, "get_wallet_address", [controller]);
    if (net.runGetMethod<address>(controller, "get_jetton_wallet_address") != rcWallet) {
        Assert.fail("RoundController jetton wallet address mismatch");
    }
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
    sendAndLog(treasury.address, createMessage({
        bounce: true,
        value: reqInt("A9_TON_FUNDING") as coins,
        dest: treasuryWallet,
        body: transferBody,
    }));

    val rcBal = net.runGetMethod<JettonWalletDataReply>(rcWallet, "get_wallet_data").jettonBalance;
    if (rcBal != rcFunding) { Assert.fail("RC funding balance mismatch"); }

    println("=== A9 {} Deployed & Verified ===", env<string>("A9_PROTOCOL_VERSION") ?? "v15");
    println("A9_JETTON_MASTER_ADDRESS={}", master);
    println("A9_ROUND_CONTROLLER_ADDRESS={}", controller);
    println("RC_JETTON_WALLET={}", rcWallet);
    println("RC_A9_BALANCE_RAW={}", rcBal);
}
