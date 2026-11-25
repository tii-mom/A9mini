// A9 协议 v16.2 — 核心玩法（20% 即时 + 40 天按秒线性释放）与安全边界全量单元测试套件
import "@acton/build"
import "@acton/emulation/network"
import "@acton/emulation/testing"
import "@acton/testing/expect"
import "@acton/types/message"
import "@acton/types/transaction"
import "@contracts/jetton/storage"
import "@contracts/types"
import "helpers"

// 1. OpenRound 权限控制与 [1.5x, 2.5x] 动态价格走廊
get fun `test open round corridor and access control`() {
    val env = setup();
    val stranger = testing.treasury("stranger").address;

    expect(net.send(stranger, createMessage({
        bounce: true,
        value: ton("0.1"),
        dest: env.rc,
        body: OpenRound { queryId: 1, twap24hUsdE8: 0, targetPriceUsdE8: P0 * 2 },
    }))).toHaveFailedTx<OpenRound>({ to: env.rc, exitCode: Errors.Unauthorized });

    expect(openRound(env, 0, 173999)).toHaveFailedTx<OpenRound>({ to: env.rc, exitCode: Errors.BadTargetPrice });
    expect(openRound(env, 0, 290001)).toHaveFailedTx<OpenRound>({ to: env.rc, exitCode: Errors.BadTargetPrice });

    expect(openRound(env, 0, 174000)).toHaveSuccessfulTx<OpenRound>({ to: env.rc });
    val r1 = round(env, 1);
    expect(r1.status).toEqual(STATUS_ACTIVE);
    expect(r1.targetPriceUsdE8).toEqual(174000 as uint128);
    expect(r1.rewardBudgetRaw).toEqual(ROUND_REWARD);
    expect(r1.vestingSeconds).toEqual(VESTING_SECONDS);

    expect(openRound(env, 200000, 400000)).toHaveFailedTx<OpenRound>({ to: env.rc, exitCode: Errors.BadRoundStatus });
}

// 2. 早鸟权重 (2.0x / 1.4x / 1.0x)、同轮累加质押与指定受益人质押
get fun `test early bird weights and beneficiary staking`() {
    val env = setup();
    expect(openRound(env, 0, P0 * 2)).toHaveSuccessfulTx<OpenRound>({ to: env.rc });
    val r1 = round(env, 1);
    val third = (STAKE_WINDOW / 3) as uint64;

    val alice = user(env, "eb-alice", 20000 * A9);
    val bob = user(env, "eb-bob", 10000 * A9);
    val carol = user(env, "eb-carol", 10000 * A9);
    val dave = testing.treasury("eb-dave").address;

    stake(env, alice, 1, 10000 * A9);
    testing.setNow((r1.stakeOpenAt + third) as uint32);
    stake(env, bob, 1, 10000 * A9);
    stakeFor(env, alice, dave, 1, 5000 * A9);
    testing.setNow((r1.stakeOpenAt + third * 2) as uint32);
    stake(env, carol, 1, 10000 * A9);
    stake(env, alice, 1, 5000 * A9);

    expect(ticketData(env, alice, 1).amountRaw).toEqual((15000 * A9) as uint128);
    expect(ticketData(env, alice, 1).weightRaw).toEqual((25000 * A9) as uint128);
    expect(ticketData(env, bob, 1).weightRaw).toEqual((14000 * A9) as uint128);
    expect(ticketData(env, carol, 1).weightRaw).toEqual((10000 * A9) as uint128);
    expect(ticketData(env, dave, 1).amountRaw).toEqual((5000 * A9) as uint128);
    expect(ticketData(env, dave, 1).weightRaw).toEqual((7000 * A9) as uint128);

    val rd = round(env, 1);
    expect(rd.totalStakeRaw).toEqual((40000 * A9) as uint128);
    expect(rd.totalWeightRaw).toEqual((56000 * A9) as uint128);
    expect(rd.stakeCount).toEqual(5 as uint32);
}

// 3. 无效入金（低额、错轮、旧版载荷、畸形 anycast 地址、封盘超时）即时原路退回
get fun `test invalid deposits and malformed anycast are instantly refunded`() {
    val env = setup();
    expect(openRound(env, 0, P0 * 2)).toHaveSuccessfulTx<OpenRound>({ to: env.rc });
    val alice = user(env, "ref-alice", 10000 * A9);
    val attacker = user(env, "ref-attacker", 100 * A9);

    stake(env, alice, 1, 500 * A9);
    expect(balanceOf(env, alice)).toEqual(10000 * A9);
    expect(round(env, 1).totalStakeRaw).toEqual(0 as uint128);

    stake(env, alice, 2, 2000 * A9);
    expect(balanceOf(env, alice)).toEqual(10000 * A9);

    transfer(alice, walletOf(env.master, alice), env.rc, 2000 * A9, ton("0.15"), emptyPayload(), ton("0.3"));
    expect(balanceOf(env, alice)).toEqual(10000 * A9);

    val v15Body = beginCell().storeUint(0x5254000F, 32).storeUint(1, 8).storeUint(0, 2).endCell();
    val v15Payload = beginCell().storeUint(1, 1).storeRef(v15Body).toSlice();
    transfer(alice, walletOf(env.master, alice), env.rc, 2000 * A9, ton("0.15"), v15Payload, ton("0.3"));
    expect(balanceOf(env, alice)).toEqual(10000 * A9);
    expect(testing.getAccountState(ticketOf(env, alice, 1)) == null).toEqual(true);

    val badAnycastBody = beginCell()
        .storeUint(OP_STAKE_DEPOSIT, 32)
        .storeUint(1, 32)
        .storeUint(0b101, 3)
        .storeUint(0, 200)
        .storeUint(0, 64)
        .endCell();
    val badAnycastPayload = beginCell().storeUint(1, 1).storeRef(badAnycastBody).toSlice();
    transfer(alice, walletOf(env.master, alice), env.rc, 2000 * A9, ton("0.15"), badAnycastPayload, ton("0.3"));
    expect(balanceOf(env, alice)).toEqual(10000 * A9);

    testing.setNow(round(env, 1).stakeCloseAt as uint32);
    stake(env, alice, 1, 2000 * A9);
    expect(balanceOf(env, alice)).toEqual(10000 * A9);

    val rcTonBefore = testing.getAccountBalance(env.rc);
    transfer(attacker, walletOf(env.master, attacker), env.rc, 1, ton("0.001"), emptyPayload(), ton("0.1"));
    expect(testing.getAccountBalance(env.rc) >= rcTonBefore - ton("0.02")).toEqual(true);
}

// 4. 15x 软顶、滚存、团队池按实发比例释放与滚存
get fun `test 15x cap and proportional team release`() {
    val env = setup();
    expect(openRound(env, 0, P0 * 2)).toHaveSuccessfulTx<OpenRound>({ to: env.rc });
    val alice = user(env, "cap-alice", 2000 * A9);
    stake(env, alice, 1, 2000 * A9);

    expect(settleRound(env, 1, 16)).toHaveSuccessfulTx<SettleRound>({ to: env.rc });
    val r1 = round(env, 1);
    expect(r1.status).toEqual(STATUS_SUCCEEDED);
    expect(r1.rewardBudgetRaw).toEqual((30000 * A9) as uint128);
    expect(r1.immediateBps).toEqual(IMMEDIATE_BPS);
    expect(r1.lockedTotalRaw).toEqual((24000 * A9) as uint128);

    val ps = pstate(env);
    expect(ps.carryRaw).toEqual(ROUND_REWARD - (30000 * A9 as uint128));
    val expectedTeam: coins = 5142857142857;
    expect(balanceOf(env, env.teamWallet)).toEqual(expectedTeam);
    expect(ps.teamCarryRaw).toEqual(TEAM_ROUND - (expectedTeam as uint128));
}

// 5. 20% 即时 + 80% 40 天按秒线性释放（每日 2%）、累计不倒扣、后续失败不影响老赢家、超时中止退本与重复领奖 bounce 解锁
get fun `test 20pct immediate plus 40d linear vesting immune to later failures and abort refund`() {
    val env = setup();
    expect(openRound(env, 0, P0 * 2)).toHaveSuccessfulTx<OpenRound>({ to: env.rc });
    val alice = user(env, "lin-alice", 10000 * A9);
    stake(env, alice, 1, 10000 * A9);

    // 10,000 A9 质押 -> 15x 上限总奖励 150,000 A9（即时 20% = 30,000 A9，40 天锁仓 80% = 120,000 A9，每日 2% = 3,000 A9）
    expect(settleRound(env, 1, 20)).toHaveSuccessfulTx<SettleRound>({ to: env.rc });
    val r1 = round(env, 1);
    val settledAt = r1.settledAt;

    // 第 0 秒：秒领 100% 本金 (10,000) + 20% 即时奖励 (30,000) = 40,000 A9
    expect(claim(env, alice, 1)).toHaveSuccessfulTx<TicketClaimReq>({ to: env.rc });
    expect(balanceOf(env, alice)).toEqual(40000 * A9);

    // 同秒重复领奖无可领份额 -> bounce 回凭证并自动解除 pending
    expect(claim(env, alice, 1)).toHaveFailedTx<TicketClaimReq>({ to: env.rc, exitCode: Errors.NothingToClaim });
    expect(ticketData(env, alice, 1).pending).toEqual(false);

    // 推进 12 小时 (0.5 天 = 1% = 1,500 A9)：验证按秒连续线性计息
    testing.setNow((settledAt + 43200) as uint32);
    val w1 = ticketData(env, alice, 1).weightRaw;
    expect(preview(env, 1, w1).unlockedLockedRaw).toEqual((1500 * A9) as uint128);
    expect(preview(env, 1, w1).burnedLockedRaw).toEqual(0 as uint128);

    // 推进至满 10 天 (+20% = 30,000 A9)，且期间第 2 轮发生失败销毁，老赢家 R1 奖励绝不受连坐影响
    expect(openRound(env, 232000, 464000)).toHaveSuccessfulTx<OpenRound>({ to: env.rc });
    val bob = user(env, "lin-bob", 5000 * A9);
    stake(env, bob, 2, 5000 * A9);
    expect(settleRound(env, 2, 10)).toHaveSuccessfulTx<SettleRound>({ to: env.rc });
    expect(round(env, 2).status).toEqual(STATUS_FAILED);

    testing.setNow((settledAt + 10 * 86400) as uint32);
    expect(claim(env, alice, 1)).toHaveSuccessfulTx<TicketClaimReq>({ to: env.rc });
    expect(balanceOf(env, alice)).toEqual(70000 * A9); // 40,000 + 30,000

    // 推进至超过 40 天（60 天后）：一次性领完剩余 60% = 90,000 A9，累计总实得 = 本金 10,000 + 奖励 150,000 = 160,000 A9，永不过期
    testing.setNow((settledAt + 60 * 86400) as uint32);
    expect(claim(env, alice, 1)).toHaveSuccessfulTx<TicketClaimReq>({ to: env.rc });
    expect(balanceOf(env, alice)).toEqual(160000 * A9);

    // 领完后再次调用 -> NothingToClaim 且 pending 解锁
    expect(claim(env, alice, 1)).toHaveFailedTx<TicketClaimReq>({ to: env.rc, exitCode: Errors.NothingToClaim });
    expect(ticketData(env, alice, 1).pending).toEqual(false);

    // 第 3 轮超时中止 -> 用户全额无许可领回本金
    expect(openRound(env, 232000, 464000)).toHaveSuccessfulTx<OpenRound>({ to: env.rc });
    val carol = user(env, "lin-carol", 5000 * A9);
    stake(env, carol, 3, 5000 * A9);
    val r3 = round(env, 3);
    testing.setNow((r3.stakeCloseAt + (OBS_WINDOW as uint64) + (ABORT_TIMEOUT as uint64)) as uint32);
    expect(net.send(carol, createMessage({ bounce: true, value: ton("0.1"), dest: env.rc, body: AbortRound { queryId: 4 } })))
        .toHaveSuccessfulTx<AbortRound>({ to: env.rc });
    expect(round(env, 3).status).toEqual(STATUS_ABORTED);
    expect(claim(env, carol, 3)).toHaveSuccessfulTx<TicketClaimReq>({ to: env.rc });
    expect(balanceOf(env, carol)).toEqual(5000 * A9);
}

// 6. 恒定 20% + 40 天线性贯穿全周期（第 11 胜以后同样 20% 即时 + 40 天线性，无突然 100% 砸盘）
get fun `test constant 20pct plus 40d vesting holds beyond round 11`() {
    val env = setup();
    val helper = user(env, "const-helper", 20000 * A9);
    var r: uint32 = 1;
    while (r <= 10) {
        expect(openRound(env, r == 1 ? (0 as uint128) : (232000 as uint128), r == 1 ? ((P0 * 2) as uint128) : (464000 as uint128))).toHaveSuccessfulTx<OpenRound>({ to: env.rc });
        stake(env, helper, r, MIN_STAKE as coins);
        expect(settleRound(env, r, 24)).toHaveSuccessfulTx<SettleRound>({ to: env.rc });
        r += 1;
    }

    val carol = user(env, "const-carol", 10000 * A9);
    expect(openRound(env, 232000, 464000)).toHaveSuccessfulTx<OpenRound>({ to: env.rc });
    stake(env, carol, 11, 10000 * A9);
    expect(settleRound(env, 11, 24)).toHaveSuccessfulTx<SettleRound>({ to: env.rc });
    expect(round(env, 11).immediateBps).toEqual(IMMEDIATE_BPS);
    expect(claim(env, carol, 11)).toHaveSuccessfulTx<TicketClaimReq>({ to: env.rc });
    // 第 11 胜依然只秒领本金 10,000 + 20% 奖励 30,000 = 40,000 A9
    expect(balanceOf(env, carol)).toEqual(40000 * A9);

    testing.setNow((round(env, 11).settledAt + (VESTING_SECONDS as uint64)) as uint32);
    expect(claim(env, carol, 11)).toHaveSuccessfulTx<TicketClaimReq>({ to: env.rc });
    expect(balanceOf(env, carol)).toEqual(160000 * A9);
}

// 7. 失败轮 100% 销毁质押本金 + 向上取整半数奖池 + 当轮团队额度 + 向上取整半数团队滚存，不可领取
get fun `test failed round burns 100pct principal and ceil half pools`() {
    val env = setup();
    expect(openRound(env, 0, P0 * 2)).toHaveSuccessfulTx<OpenRound>({ to: env.rc });
    val alice = user(env, "fail-alice", 10000 * A9);
    stake(env, alice, 1, 10000 * A9);

    // P1-2: 低于 0.35 TON 的结算请求必须以 NotEnoughValue 拒绝
    val r1Before = round(env, 1);
    testing.setNow((r1Before.stakeCloseAt + (OBS_WINDOW as uint64)) as uint32);
    expect(net.send(env.keeper, createMessage({
        bounce: true, value: ton("0.25"), dest: env.rc,
        body: SettleRound { queryId: 2, roundId: 1, qualifiedCandles: 10, candleHash: 0x1234 as uint256 },
    }))).toHaveFailedTx<SettleRound>({ to: env.rc, exitCode: Errors.NotEnoughValue });

    val supBefore = totalSupply(env);
    expect(settleRound(env, 1, 10)).toHaveSuccessfulTx<SettleRound>({ to: env.rc });
    expect(round(env, 1).status).toEqual(STATUS_FAILED);
    val expectedRewardBurn = ((ROUND_REWARD + 1) / 2) as coins;
    expect(totalSupply(env)).toEqual(supBefore - expectedRewardBurn - 10000 * A9 - (TEAM_ROUND as coins));
    expect(claim(env, alice, 1)).toHaveFailedTx<TicketClaimReq>({ to: env.rc, exitCode: Errors.NothingToClaim });
    expect(ticketData(env, alice, 1).pending).toEqual(false);
}

// 8. P1-3 空轮对称：零质押轮无论达标还是失败均 100% 滚存，不销毁奖池/团队池、不增加胜场
get fun `test zero stake round rolls over 100pct on both pass and fail`() {
    val env = setup();
    expect(openRound(env, 0, P0 * 2)).toHaveSuccessfulTx<OpenRound>({ to: env.rc });
    val alice = user(env, "zs-alice", 10000 * A9);
    stake(env, alice, 1, 10000 * A9);
    expect(settleRound(env, 1, 24)).toHaveSuccessfulTx<SettleRound>({ to: env.rc });

    val psAfterR1 = pstate(env);
    val supAfterR1 = totalSupply(env);
    val teamBalAfterR1 = balanceOf(env, env.teamWallet);

    // R2 零质押达标 -> 100% 滚存、不计胜场、零释放、零销毁
    expect(openRound(env, 232000, 464000)).toHaveSuccessfulTx<OpenRound>({ to: env.rc });
    expect(settleRound(env, 2, 24)).toHaveSuccessfulTx<SettleRound>({ to: env.rc });
    val psAfterR2 = pstate(env);
    expect(round(env, 2).status).toEqual(STATUS_SUCCEEDED);
    expect(round(env, 2).rewardBudgetRaw).toEqual(0 as uint128);
    expect(psAfterR2.successCount).toEqual(psAfterR1.successCount);
    expect(psAfterR2.carryRaw).toEqual(psAfterR1.carryRaw + ROUND_REWARD);
    expect(psAfterR2.teamCarryRaw).toEqual(psAfterR1.teamCarryRaw + TEAM_ROUND);
    expect(totalSupply(env)).toEqual(supAfterR1);
    expect(balanceOf(env, env.teamWallet)).toEqual(teamBalAfterR1);

    // R3 零质押失败 -> 同样 100% 滚存、零销毁
    expect(openRound(env, 232000, 464000)).toHaveSuccessfulTx<OpenRound>({ to: env.rc });
    expect(settleRound(env, 3, 5)).toHaveSuccessfulTx<SettleRound>({ to: env.rc });
    val psAfterR3 = pstate(env);
    expect(round(env, 3).status).toEqual(STATUS_FAILED);
    expect(round(env, 3).rewardBudgetRaw).toEqual(0 as uint128);
    expect(psAfterR3.carryRaw).toEqual(psAfterR2.carryRaw + ROUND_REWARD);
    expect(psAfterR3.teamCarryRaw).toEqual(psAfterR2.teamCarryRaw + TEAM_ROUND);
    expect(totalSupply(env)).toEqual(supAfterR1);
}

// 9. P0-3 边界：最后仅剩 1 raw A9 失败时向上取整归零，正确触发 endAt（不陷入 1 raw 死循环）
get fun `test failed round ceil burn terminates final 1 raw carry cleanly`() {
    val env = setup();
    // 部署一个仅剩 poolRemainingRaw=0, carryRaw=1 raw 的微型控制器验证 P0-3
    val cfg = ProtocolConfig {
        keeper: env.keeper,
        roundOpener: env.roundOpener,
        jettonMaster: env.master,
        econ: ProtocolEcon {
            teamWallet: env.teamWallet,
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
        poolRemainingRaw: 0,
        carryRaw: 1,
        teamPoolRemainingRaw: 0,
        teamCarryRaw: 1,
        lastSuccessAt: 0,
        endAt: 0,
        pendingTeamReleaseRaw: 0,
        pendingBurnRaw: 0,
    };
    val deployer = testing.treasury("p03-rc-deployer");
    val init = ContractState { code: build("RoundController"), data: st.toCell() };
    val miniRc = AutoDeployAddress { stateInit: init }.calculateAddress();
    expect(net.send(deployer.address, createMessage({ bounce: false, value: ton("5"), dest: { stateInit: init }, body: TopUpTons {} })))
        .toHaveSuccessfulDeploy({ to: miniRc });
    transfer(env.treasury, env.treasuryWallet, miniRc, 2000 * A9, 0, emptyPayload(), ton("0.2"));

    val alice = user(env, "p03-alice", 2000 * A9);
    expect(net.send(env.roundOpener, createMessage({
        bounce: true, value: ton("0.1"), dest: miniRc,
        body: OpenRound { queryId: 1, twap24hUsdE8: 0, targetPriceUsdE8: P0 * 2 },
    }))).toHaveSuccessfulTx<OpenRound>({ to: miniRc });

    transfer(alice, walletOf(env.master, alice), miniRc, 1000 * A9, ton("0.15"), stakePayload(1), ton("0.3"));
    val rd1 = net.runGetMethod<RoundView>(miniRc, "get_round", [1]);
    testing.setNow((rd1.stakeCloseAt + (OBS_WINDOW as uint64)) as uint32);
    expect(net.send(env.keeper, createMessage({
        bounce: true, value: ton("0.4"), dest: miniRc,
        body: SettleRound { queryId: 2, roundId: 1, qualifiedCandles: 5, candleHash: 0x99 as uint256 },
    }))).toHaveSuccessfulTx<SettleRound>({ to: miniRc });

    val ps = net.runGetMethod<ProtocolStateView>(miniRc, "get_protocol_state");
    expect(ps.carryRaw).toEqual(0 as uint128);
    expect(ps.teamCarryRaw).toEqual(0 as uint128);
    expect(ps.endAt > 0).toEqual(true);
}

// 10. 奖池耗尽触发 endAt、销毁剩余团队池且已胜轮继续走 40 天线性解锁不受影响
get fun `test pool exhaustion triggers endAt and preserves 40d vesting`() {
    val env = setup();
    val whale = user(env, "whale", 500000000 * A9);
    val bigStake = 50000000 * A9;

    var r: uint32 = 1;
    while (r <= 10) {
        expect(openRound(env, r == 1 ? (0 as uint128) : (232000 as uint128), r == 1 ? ((P0 * 2) as uint128) : (464000 as uint128))).toHaveSuccessfulTx<OpenRound>({ to: env.rc });
        stake(env, whale, r, bigStake);
        expect(settleRound(env, r, 24)).toHaveSuccessfulTx<SettleRound>({ to: env.rc });
        r += 1;
    }

    val ps = pstate(env);
    expect(ps.endAt > 0).toEqual(true);
    expect(ps.poolRemainingRaw).toEqual(0 as uint128);
    expect(ps.carryRaw).toEqual(0 as uint128);
    expect(ps.teamPoolRemainingRaw).toEqual(0 as uint128);
    expect(ps.teamCarryRaw).toEqual(0 as uint128);

    expect(openRound(env, 232000, 464000)).toHaveFailedTx<OpenRound>({ to: env.rc, exitCode: Errors.ProtocolEnded });

    val r10 = round(env, 10);
    val w10 = ticketData(env, whale, 10).weightRaw;
    expect(preview(env, 10, w10).unlockedLockedRaw).toEqual(0 as uint128);

    testing.setNow((r10.settledAt + (VESTING_SECONDS as uint64) / 2) as uint32);
    // R10 奖池 700M -> 80% 锁仓 560M -> 20 天后解锁 280M
    expect(preview(env, 10, w10).unlockedLockedRaw).toEqual((280000000 * A9) as uint128);

    testing.setNow((r10.settledAt + (VESTING_SECONDS as uint64)) as uint32);
    expect(preview(env, 10, w10).unlockedLockedRaw).toEqual((560000000 * A9) as uint128);
}

// 11. 跨越 255 -> 256 轮边界验证 uint32 轮次与独立凭证地址
get fun `test round 255 to 256 preserves tickets and 40d linear rewards`() {
    val env = setup();
    var r: uint32 = 1;
    while (r < 255) {
        val twap = r == 1 ? 0 : 232000;
        val target = r == 1 ? 232000 : 464000;
        expect(openRound(env, twap as uint128, target as uint128)).toHaveSuccessfulTx<OpenRound>({ to: env.rc });
        val rd = round(env, r);
        testing.setNow((rd.stakeCloseAt + (OBS_WINDOW as uint64) + (ABORT_TIMEOUT as uint64)) as uint32);
        expect(net.send(env.keeper, createMessage({
            bounce: true, value: ton("0.1"), dest: env.rc, body: AbortRound { queryId: 4 },
        }))).toHaveSuccessfulTx<AbortRound>({ to: env.rc });
        r += 1;
    }

    val alice = user(env, "round-boundary", 20000 * A9);
    expect(openRound(env, 232000, 464000)).toHaveSuccessfulTx<OpenRound>({ to: env.rc });
    stake(env, alice, 255, 10000 * A9);
    expect(settleRound(env, 255, 24)).toHaveSuccessfulTx<SettleRound>({ to: env.rc });

    expect(openRound(env, 232000, 464000)).toHaveSuccessfulTx<OpenRound>({ to: env.rc });
    expect(pstate(env).currentRoundId).toEqual(256 as uint32);
    stake(env, alice, 256, 10000 * A9);
    expect(ticketOf(env, alice, 255) != ticketOf(env, alice, 256)).toEqual(true);
    expect(ticketData(env, alice, 256).roundId).toEqual(256 as uint32);
    expect(settleRound(env, 256, 24)).toHaveSuccessfulTx<SettleRound>({ to: env.rc });

    // 两轮均满 40 天后合并领奖：每轮 10,000 本金 + 150,000 奖励 = 160,000 -> 两轮合计 320,000 A9
    testing.setNow((round(env, 256).settledAt + (VESTING_SECONDS as uint64)) as uint32);
    expect(claim(env, alice, 255)).toHaveSuccessfulTx<TicketClaimReq>({ to: env.rc });
    expect(claim(env, alice, 256)).toHaveSuccessfulTx<TicketClaimReq>({ to: env.rc });
    expect(balanceOf(env, alice)).toEqual(320000 * A9);
}

// 12. P0-2: 失败轮对 teamCarryRaw 向上取整销毁 + 未注资 RC 结算触发 JettonBurn bounce 后经 RetrySettlePayouts O(1) 补烧守恒
get fun `test bounce recovery via RetrySettlePayouts preserves accounting`() {
    val env = setup();
    // 部署一个未注资 A9 的 RoundController，故意触发 SettleRound 的 teamRelease/burn 发生 JettonWallet bounce
    val bncKeeper = testing.treasury("bnc-keeper").address;
    val cfg = ProtocolConfig {
        keeper: bncKeeper,
        roundOpener: env.roundOpener,
        jettonMaster: env.master,
        econ: ProtocolEcon {
            teamWallet: env.teamWallet,
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
    val deployer = testing.treasury("bnc-rc-deployer");
    val init = ContractState { code: build("RoundController"), data: st.toCell() };
    val emptyRc = AutoDeployAddress { stateInit: init }.calculateAddress();
    expect(net.send(deployer.address, createMessage({ bounce: false, value: ton("5"), dest: { stateInit: init }, body: TopUpTons {} })))
        .toHaveSuccessfulDeploy({ to: emptyRc });

    // 仅给用户质押 10,000 A9，不注资奖池 -> 结算失败试图销毁 350M+120M+10k A9 时 JettonWallet 余额不足必 bounce 回 RC
    val alice = user(env, "bnc-alice", 10000 * A9);
    expect(net.send(env.roundOpener, createMessage({
        bounce: true, value: ton("0.1"), dest: emptyRc,
        body: OpenRound { queryId: 1, twap24hUsdE8: 0, targetPriceUsdE8: P0 * 2 },
    }))).toHaveSuccessfulTx<OpenRound>({ to: emptyRc });
    transfer(alice, walletOf(env.master, alice), emptyRc, 10000 * A9, ton("0.15"), stakePayload(1), ton("0.3"));

    val rd1 = net.runGetMethod<RoundView>(emptyRc, "get_round", [1]);
    testing.setNow((rd1.stakeCloseAt + (OBS_WINDOW as uint64)) as uint32);
    expect(net.send(bncKeeper, createMessage({
        bounce: true, value: ton("0.4"), dest: emptyRc,
        body: SettleRound { queryId: 2, roundId: 1, qualifiedCandles: 5, candleHash: 0x55 as uint256 },
    }))).toHaveSuccessfulTx<SettleRound>({ to: emptyRc });

    val expectedBurn = ((ROUND_REWARD + 1) / 2) + (TEAM_ROUND as uint128) + (10000 * A9 as uint128);
    val psBounced = net.runGetMethod<ProtocolStateView>(emptyRc, "get_protocol_state");
    expect(psBounced.pendingBurnRaw).toEqual(expectedBurn);

    // 补足 A9 资金后，任意地址可无许可调用 RetrySettlePayouts 完成补烧并清零 pendingBurnRaw
    transfer(env.treasury, env.treasuryWallet, emptyRc, 500000000 * A9, 0, emptyPayload(), ton("0.2"));
    val supBeforeRetry = totalSupply(env);
    val stranger = testing.treasury("bnc-stranger").address;
    expect(net.send(stranger, createMessage({
        bounce: true, value: ton("0.4"), dest: emptyRc,
        body: RetrySettlePayouts { queryId: 99 },
    }))).toHaveSuccessfulTx<RetrySettlePayouts>({ to: emptyRc });

    val psAfterRetry = net.runGetMethod<ProtocolStateView>(emptyRc, "get_protocol_state");
    expect(psAfterRetry.pendingBurnRaw).toEqual(0 as uint128);
    expect(totalSupply(env)).toEqual(supBeforeRetry - (expectedBurn as coins));
}
