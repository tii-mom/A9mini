// A9 协议 v16 — 测试环境与辅助函数 (Acton 1.1.0)
import "@stdlib/strings"
import "@acton/build"
import "@acton/emulation/network"
import "@acton/emulation/testing"
import "@acton/testing/expect"
import "@acton/types/message"

import "@contracts/jetton/storage"
import "@contracts/types"

struct (0x00000015) MintOnceMsg {
    queryId: uint64
    recipient: address
    tonAmount: coins
    jettonAmount: coins
    totalTonAmount: coins
    forwardPayload: RemainingBitsAndRefs
}

struct (0x0f8a7ea5) AskToTransferMsg {
    queryId: uint64
    jettonAmount: coins
    transferRecipient: address
    sendExcessesTo: address?
    customPayload: cell?
    forwardTonAmount: coins
    forwardPayload: RemainingBitsAndRefs
}

struct (0x595f07bc) AskToBurnMsg {
    queryId: uint64
    jettonAmount: coins
    sendExcessesTo: address?
    customPayload: cell?
}

const SUPPLY: coins = 10000000000000000000;      // 10B A9
const A9: coins = 1000000000;                    // 1 A9
const REWARD_POOL: uint128 = 7000000000000000000; // 7B A9
const TEAM_POOL: uint128 = 1200000000000000000;   // 1.2B A9
const RC_FUNDING: coins = 8200000000000000000;    // 8.2B A9
const ROUND_REWARD: uint128 = 700000000000000000; // 700M A9
const TEAM_ROUND: uint128 = 120000000000000000;   // 120M A9
const MIN_STAKE: uint128 = 1000000000000;         // 1,000 A9
const P0: uint128 = 116000;                       // $0.00116
const STAKE_WINDOW: uint32 = 129600;              // 36h
const OBS_WINDOW: uint32 = 86400;                 // 24h
const CANDLES: uint8 = 24;
const MIN_QUALIFIED: uint8 = 16;
const ABORT_TIMEOUT: uint32 = 604800;             // 7d
const VESTING_SECONDS: uint32 = 3456000;          // 40d (每日 2% × 40 = 80%)
const T0: uint32 = 1000000;

struct Env {
    master: address
    rc: address
    rcWallet: address
    keeper: address
    roundOpener: address
    treasury: address
    treasuryWallet: address
    teamWallet: address
}

fun emptyPayload(): slice {
    return beginCell().storeUint(0, 1).toSlice();
}

fun walletOf(master: address, owner: address): address {
    return net.runGetMethod<address>(master, "get_wallet_address", [owner]);
}

fun balanceOf(env: Env, owner: address): coins {
    val w = walletOf(env.master, owner);
    if (testing.getAccountState(w) == null) { return 0; }
    return net.runGetMethod<JettonWalletDataReply>(w, "get_wallet_data").jettonBalance;
}

fun totalSupply(env: Env): coins {
    return net.runGetMethod<coins>(env.master, "get_total_supply");
}

fun transfer(from: address, wallet: address, to: address, amount: coins, forwardTon: coins, payload: slice, value: coins): SendResultList {
    return net.send(from, createMessage({
        bounce: true,
        value,
        dest: wallet,
        body: AskToTransferMsg {
            queryId: 7,
            jettonAmount: amount,
            transferRecipient: to,
            sendExcessesTo: from,
            customPayload: null,
            forwardTonAmount: forwardTon,
            forwardPayload: payload,
        },
    }));
}

fun deployMaster(admin: address): address {
    val deployer = testing.treasury("v16-jetton-deployer");
    var metadata: OnchainMetadataReply = { contentDict: [] };
    metadata.contentDict.set("uri".sha256(), "https://a9.lat/a9.json".prefixWith00());
    val storage = MasterStorage { totalSupply: 0, adminAddress: admin, nextAdminAddress: null, metadata: metadata.toCell() };
    val init = ContractState { code: build("JettonMaster"), data: storage.toCell() };
    val addr = AutoDeployAddress { stateInit: init }.calculateAddress();
    expect(net.send(deployer.address, createMessage({ bounce: false, value: ton("5"), dest: { stateInit: init }, body: TopUpTons {} })))
        .toHaveSuccessfulDeploy({ to: addr });
    return addr;
}

fun setup(): Env {
    testing.setNow(T0);
    val treasury = testing.treasury("v16-treasury");
    val keeper = testing.treasury("v16-keeper");
    val opener = testing.treasury("v16-opener");
    val team = testing.treasury("v16-team");

    val master = deployMaster(treasury.address);
    expect(net.send(treasury.address, createMessage({
        bounce: true,
        value: ton("1"),
        dest: master,
        body: MintOnceMsg {
            queryId: 1,
            recipient: treasury.address,
            tonAmount: ton("0.3"),
            jettonAmount: SUPPLY,
            totalTonAmount: ton("0.5"),
            forwardPayload: emptyPayload(),
        },
    }))).toHaveSuccessfulTx<MintOnceMsg>({ to: master });

    // P0-1: 验明 treasuryWallet 实收 10B 后发 DropMinterAdmin 永久弃权
    expect(net.send(treasury.address, createMessage({
        bounce: true,
        value: ton("0.05"),
        dest: master,
        body: DropMinterAdmin { queryId: 2 },
    }))).toHaveSuccessfulTx<DropMinterAdmin>({ to: master });

    val cfg = ProtocolConfig {
        keeper: keeper.address,
        roundOpener: opener.address,
        jettonMaster: master,
        econ: ProtocolEcon {
            teamWallet: team.address,
            p0UsdE8: P0,
            roundRewardRaw: ROUND_REWARD,
            teamRoundRaw: TEAM_ROUND,
            minStakeRaw: MIN_STAKE,
        }.toCell(),
        timing: ProtocolTiming {
            stakeDurationSeconds: STAKE_WINDOW,
            observationSeconds: OBS_WINDOW,
            candleCount: CANDLES,
            minQualifiedCandles: MIN_QUALIFIED,
            abortTimeoutSeconds: ABORT_TIMEOUT,
            vestingSeconds: VESTING_SECONDS,
        }.toCell(),
        codes: ProtocolCodes {
            jettonWalletCode: build("JettonWallet"),
            ticketCode: build("StakeTicket"),
        }.toCell(),
    };
    val st = Storage {
        config: cfg.toCell(),
        rounds: [],
        currentRoundId: 0,
        successCount: 0,
        poolRemainingRaw: REWARD_POOL,
        carryRaw: 0,
        teamPoolRemainingRaw: TEAM_POOL,
        teamCarryRaw: 0,
        lastSuccessAt: 0,
        endAt: 0,
        pendingTeamReleaseRaw: 0,
        pendingBurnRaw: 0,
    };

    val deployer = testing.treasury("v16-rc-deployer");
    val init = ContractState { code: build("RoundController"), data: st.toCell() };
    val rc = AutoDeployAddress { stateInit: init }.calculateAddress();
    expect(net.send(deployer.address, createMessage({ bounce: false, value: ton("10"), dest: { stateInit: init }, body: TopUpTons {} })))
        .toHaveSuccessfulDeploy({ to: rc });

    val env = Env {
        master,
        rc,
        rcWallet: walletOf(master, rc),
        keeper: keeper.address,
        roundOpener: opener.address,
        treasury: treasury.address,
        treasuryWallet: walletOf(master, treasury.address),
        teamWallet: team.address,
    };
    expect(net.runGetMethod<address>(rc, "get_jetton_wallet_address")).toEqual(env.rcWallet);

    transfer(treasury.address, env.treasuryWallet, rc, RC_FUNDING, 0, emptyPayload(), ton("0.2"));
    expect(balanceOf(env, rc)).toEqual(RC_FUNDING);
    return env;
}

fun user(env: Env, name: string, amount: coins): address {
    val u = testing.treasury(name).address;
    transfer(env.treasury, env.treasuryWallet, u, amount, 0, emptyPayload(), ton("0.2"));
    return u;
}

fun stakePayloadFor(roundId: uint32, beneficiary: address?): slice {
    var b = beginCell()
        .storeUint(OP_STAKE_DEPOSIT, 32)
        .storeUint(roundId, 32);
    if (beneficiary == null) {
        b = b.storeUint(0, 2);
    } else {
        b = b.storeAddress(beneficiary!);
    }
    return beginCell().storeUint(1, 1).storeRef(b.endCell()).toSlice();
}

fun stakePayload(roundId: uint32): slice {
    return stakePayloadFor(roundId, null);
}

fun stake(env: Env, owner: address, roundId: uint32, amount: coins): SendResultList {
    return transfer(owner, walletOf(env.master, owner), env.rc, amount, ton("0.15"), stakePayload(roundId), ton("0.3"));
}

fun stakeFor(env: Env, payer: address, beneficiary: address, roundId: uint32, amount: coins): SendResultList {
    return transfer(payer, walletOf(env.master, payer), env.rc, amount, ton("0.15"), stakePayloadFor(roundId, beneficiary), ton("0.3"));
}

fun openRound(env: Env, twap24h: uint128, targetPrice: uint128): SendResultList {
    return net.send(env.roundOpener, createMessage({
        bounce: true,
        value: ton("0.1"),
        dest: env.rc,
        body: OpenRound { queryId: 1, twap24hUsdE8: twap24h, targetPriceUsdE8: targetPrice },
    }));
}

fun settleRound(env: Env, roundId: uint32, qualified: uint8): SendResultList {
    val rd = round(env, roundId);
    testing.setNow((rd.stakeCloseAt + (OBS_WINDOW as uint64)) as uint32);
    return net.send(env.keeper, createMessage({
        bounce: true,
        value: ton("0.4"),
        dest: env.rc,
        body: SettleRound { queryId: 2, roundId, qualifiedCandles: qualified, candleHash: 0x1234 as uint256 },
    }));
}

fun claim(env: Env, owner: address, roundId: uint32): SendResultList {
    return net.send(owner, createMessage({
        bounce: true,
        value: ton("0.22"),
        dest: ticketOf(env, owner, roundId),
        body: TicketClaim { queryId: 3 },
    }));
}

fun ticketOf(env: Env, owner: address, roundId: uint32): address {
    return net.runGetMethod<address>(env.rc, "get_ticket_address", [owner, roundId]);
}

fun ticketData(env: Env, owner: address, roundId: uint32): TicketView {
    return net.runGetMethod<TicketView>(ticketOf(env, owner, roundId), "get_ticket_data");
}

fun pstate(env: Env): ProtocolStateView {
    return net.runGetMethod<ProtocolStateView>(env.rc, "get_protocol_state");
}

fun round(env: Env, roundId: uint32): RoundView {
    return net.runGetMethod<RoundView>(env.rc, "get_round", [roundId]);
}

fun preview(env: Env, roundId: uint32, weight: uint128): RewardPreview {
    return net.runGetMethod<RewardPreview>(env.rc, "get_reward_preview", [roundId, weight]);
}
