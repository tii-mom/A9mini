// A9 协议 v16 — 核心玩法与安全边界全量单元测试套件
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

    // 低于最小质押额 -> 即时退回
    stake(env, alice, 1, 500 * A9);
    expect(balanceOf(env, alice)).toEqual(10000 * A9);
    expect(round(env, 1).totalStakeRaw).toEqual(0 as uint128);

    // 错误轮号 -> 即时退回
    stake(env, alice, 2, 2000 * A9);
    expect(balanceOf(env, alice)).toEqual(10000 * A9);

    // 空载荷 -> 即时退回
    transfer(alice, walletOf(env.master, alice), env.rc, 2000 * A9, ton("0.15"), emptyPayload(), ton("0.3"));
    expect(balanceOf(env, alice)).toEqual(10000 * A9);

    // v15 旧版操作码 (0x5254000F + uint8) -> 全额退回且不部署凭证
    val v15Body = beginCell().storeUint(0x5254000F, 32).storeUint(1, 8).storeUint(0, 2).endCell();
    val v15Payload = beginCell().storeUint(1, 1).storeRef(v15Body).toSlice();
    transfer(alice, walletOf(env.master, alice), env.rc, 2000 * A9, ton("0.15"), v15Payload, ton("0.3"));
    expect(balanceOf(env, alice)).toEqual(10000 * A9);
    expect(testing.getAccountState(ticketOf(env, alice, 1)) == null).toEqual(true);

    // 畸形 anycast=1 (0b101) 地址载荷 -> 不抛异常吞币，安全原路退回
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

    // 质押窗口关闭后 -> 即时退回
    testing.setNow(round(env, 1).stakeCloseAt as uint32);
    stake(env, alice, 1, 2000 * A9);
    expect(balanceOf(env, alice)).toEqual(10000 * A9);

    // 超低 Gas 垃圾粉尘不抽干主控原有 GRAM 储备
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

    val ps = pstate(env);
    expect(ps.carryRaw).toEqual(ROUND_REWARD - (30000 * A9 as uint128));
    val expectedTeam: coins = 5142857142857;
    expect(balanceOf(env, env.teamWallet)).toEqual(expectedTeam);
    expect(ps.teamCarryRaw).toEqual(TEAM_ROUND - (expectedTeam as uint128));
}

// 5. 第一档 (1-5 胜: 20% + 4x20%)、失败对称销毁、超时中止退本金及重复领奖 bounce 解锁
get fun `test tier 1 unlock symmetric failure burn neutral abort and claim bounce`() {
    val env = setup();
    expect(openRound(env, 0, P0 * 2)).toHaveSuccessfulTx<OpenRound>({ to: env.rc });
    val alice = user(env, "t1-alice", 10000 * A9);
    val helper = user(env, "t1-helper", 10000 * A9);
    stake(env, alice, 1, 10000 * A9);

    expect(settleRound(env, 1, 20)).toHaveSuccessfulTx<SettleRound>({ to: env.rc });
    expect(claim(env, alice, 1)).toHaveSuccessfulTx<TicketClaimReq>({ to: env.rc });
    expect(balanceOf(env, alice)).toEqual(40000 * A9);

    // 立即重复领奖无可领份额 -> bounce 回凭证并自动解除 pending
    expect(claim(env, alice, 1)).toHaveFailedTx<TicketClaimReq>({ to: env.rc, exitCode: Errors.NothingToClaim });
    expect(ticketData(env, alice, 1).pending).toEqual(false);

    // 第 2 轮获胜（注入最小有效质押）-> 解锁 R1 第 1 片 (30,000 A9)
    expect(openRound(env, 232000, 464000)).toHaveSuccessfulTx<OpenRound>({ to: env.rc });
    stake(env, helper, 2, MIN_STAKE as coins);
    expect(settleRound(env, 2, 16)).toHaveSuccessfulTx<SettleRound>({ to: env.rc });
    expect(round(env, 1).unlockedSlices).toEqual(1 as uint8);
    expect(claim(env, alice, 1)).toHaveSuccessfulTx<TicketClaimReq>({ to: env.rc });
    expect(balanceOf(env, alice)).toEqual(70000 * A9);

    // 第 3 轮失败 -> 销毁 R3 一半预算 + R3 团队额度 + 累积团队滚存一半 + R1 切片 (30,000 A9) + R2 切片 (3,000 A9)
    expect(openRound(env, 232000, 464000)).toHaveSuccessfulTx<OpenRound>({ to: env.rc });
    val r3Budget = round(env, 3).rewardBudgetRaw as coins;
    val teamCarryBeforeFail = pstate(env).teamCarryRaw;
    val teamCarryBurn = teamCarryBeforeFail / 2;
    val supBeforeFail = totalSupply(env);
    expect(settleRound(env, 3, 15)).toHaveSuccessfulTx<SettleRound>({ to: env.rc });
    expect(round(env, 1).burnedSlices).toEqual(1 as uint8);
    expect(round(env, 2).burnedSlices).toEqual(1 as uint8);
    expect(pstate(env).teamCarryRaw).toEqual(teamCarryBeforeFail - teamCarryBurn);
    expect(totalSupply(env)).toEqual(supBeforeFail - (r3Budget / 2) - (TEAM_ROUND as coins) - (teamCarryBurn as coins) - 33000 * A9);

    // 第 4 轮超时中止 -> R1 切片保持中性不变，R4 用户全额领回本金
    expect(openRound(env, 232000, 464000)).toHaveSuccessfulTx<OpenRound>({ to: env.rc });
    val bob = user(env, "t1-bob", 5000 * A9);
    stake(env, bob, 4, 5000 * A9);
    val r4 = round(env, 4);
    testing.setNow((r4.stakeCloseAt + (OBS_WINDOW as uint64) + (ABORT_TIMEOUT as uint64)) as uint32);
    expect(net.send(bob, createMessage({ bounce: true, value: ton("0.1"), dest: env.rc, body: AbortRound { queryId: 4 } })))
        .toHaveSuccessfulTx<AbortRound>({ to: env.rc });
    expect(round(env, 4).status).toEqual(STATUS_ABORTED);
    expect(round(env, 1).unlockedSlices).toEqual(1 as uint8);
    expect(round(env, 1).burnedSlices).toEqual(1 as uint8);
    expect(claim(env, bob, 4)).toHaveSuccessfulTx<TicketClaimReq>({ to: env.rc });
    expect(balanceOf(env, bob)).toEqual(5000 * A9);

    // 第 5、6 轮获胜（注入最小有效质押）-> 解锁 R1 剩余 2 片 (60,000 A9)
    expect(openRound(env, 232000, 464000)).toHaveSuccessfulTx<OpenRound>({ to: env.rc });
    stake(env, helper, 5, MIN_STAKE as coins);
    expect(settleRound(env, 5, 24)).toHaveSuccessfulTx<SettleRound>({ to: env.rc });
    expect(openRound(env, 232000, 464000)).toHaveSuccessfulTx<OpenRound>({ to: env.rc });
    stake(env, helper, 6, MIN_STAKE as coins);
    expect(settleRound(env, 6, 24)).toHaveSuccessfulTx<SettleRound>({ to: env.rc });

    expect(claim(env, alice, 1)).toHaveSuccessfulTx<TicketClaimReq>({ to: env.rc });
    expect(balanceOf(env, alice)).toEqual(130000 * A9);
}

// 6. 第二档 (6-10 胜: 40% + 2x30%) 与第三档 (11+ 胜: 100% 即时解锁)
get fun `test tier 2 and tier 3 beyond round 10`() {
    val env = setup();
    val helper = user(env, "t2-helper", 20000 * A9);
    var r: uint32 = 1;
    while (r <= 5) {
        expect(openRound(env, r == 1 ? (0 as uint128) : (232000 as uint128), r == 1 ? ((P0 * 2) as uint128) : (464000 as uint128))).toHaveSuccessfulTx<OpenRound>({ to: env.rc });
        stake(env, helper, r, MIN_STAKE as coins);
        expect(settleRound(env, r, 24)).toHaveSuccessfulTx<SettleRound>({ to: env.rc });
        r += 1;
    }

    val bob = user(env, "t2-bob", 10000 * A9);
    expect(openRound(env, 232000, 464000)).toHaveSuccessfulTx<OpenRound>({ to: env.rc });
    stake(env, bob, 6, 10000 * A9);
    expect(settleRound(env, 6, 24)).toHaveSuccessfulTx<SettleRound>({ to: env.rc });
    expect(round(env, 6).immediateBps).toEqual(4000 as uint16);
    expect(round(env, 6).lockedSlices).toEqual(2 as uint8);
    expect(claim(env, bob, 6)).toHaveSuccessfulTx<TicketClaimReq>({ to: env.rc });
    expect(balanceOf(env, bob)).toEqual(70000 * A9);

    while (r <= 10) {
        if (r > 6) {
            expect(openRound(env, 232000, 464000)).toHaveSuccessfulTx<OpenRound>({ to: env.rc });
            stake(env, helper, r, MIN_STAKE as coins);
            expect(settleRound(env, r, 24)).toHaveSuccessfulTx<SettleRound>({ to: env.rc });
        }
        r += 1;
    }
    expect(claim(env, bob, 6)).toHaveSuccessfulTx<TicketClaimReq>({ to: env.rc });
    expect(balanceOf(env, bob)).toEqual(160000 * A9);

    val carol = user(env, "t3-carol", 10000 * A9);
    expect(openRound(env, 232000, 464000)).toHaveSuccessfulTx<OpenRound>({ to: env.rc });
    stake(env, carol, 11, 10000 * A9);
    expect(settleRound(env, 11, 24)).toHaveSuccessfulTx<SettleRound>({ to: env.rc });
    expect(round(env, 11).immediateBps).toEqual(10000 as uint16);
    expect(round(env, 11).lockedSlices).toEqual(0 as uint8);
    expect(claim(env, carol, 11)).toHaveSuccessfulTx<TicketClaimReq>({ to: env.rc });
    expect(balanceOf(env, carol)).toEqual(160000 * A9);
}

// 7. 失败轮 100% 销毁质押本金，不可领取
get fun `test failed round burns 100pct principal`() {
    val env = setup();
    expect(openRound(env, 0, P0 * 2)).toHaveSuccessfulTx<OpenRound>({ to: env.rc });
    val alice = user(env, "fail-alice", 10000 * A9);
    stake(env, alice, 1, 10000 * A9);

    val supBefore = totalSupply(env);
    expect(settleRound(env, 1, 10)).toHaveSuccessfulTx<SettleRound>({ to: env.rc });
    expect(round(env, 1).status).toEqual(STATUS_FAILED);
    expect(totalSupply(env)).toEqual(supBefore - (ROUND_REWARD as coins / 2) - 10000 * A9 - (TEAM_ROUND as coins));
    expect(claim(env, alice, 1)).toHaveFailedTx<TicketClaimReq>({ to: env.rc, exitCode: Errors.NothingToClaim });
    expect(ticketData(env, alice, 1).pending).toEqual(false);
}

// 8. 90 天停滞销毁仅销毁未决切片，永久保留已解锁奖励
get fun `test 90d inactivity burn preserves already unlocked rewards`() {
    val env = setup();
    expect(openRound(env, 0, P0 * 2)).toHaveSuccessfulTx<OpenRound>({ to: env.rc });
    val alice = user(env, "inact-alice", 10000 * A9);
    val helper = user(env, "inact-helper", 5000 * A9);
    stake(env, alice, 1, 10000 * A9);
    expect(settleRound(env, 1, 24)).toHaveSuccessfulTx<SettleRound>({ to: env.rc });

    expect(openRound(env, 232000, 464000)).toHaveSuccessfulTx<OpenRound>({ to: env.rc });
    stake(env, helper, 2, MIN_STAKE as coins);
    expect(settleRound(env, 2, 24)).toHaveSuccessfulTx<SettleRound>({ to: env.rc });

    val ps = pstate(env);
    val burnMsg = createMessage({ bounce: true, value: ton("0.2"), dest: env.rc, body: BurnInactiveLocked { queryId: 9 } });

    testing.setNow((ps.lastSuccessAt + (INACTIVITY_BURN as uint64) - 1) as uint32);
    expect(net.send(env.treasury, burnMsg)).toHaveFailedTx<BurnInactiveLocked>({ to: env.rc, exitCode: Errors.TooEarly });

    val supBefore = totalSupply(env);
    testing.setNow((ps.lastSuccessAt + (INACTIVITY_BURN as uint64)) as uint32);
    expect(net.send(env.treasury, burnMsg)).toHaveSuccessfulTx<BurnInactiveLocked>({ to: env.rc });
    // 销毁 R1 剩余 3 片 (90,000 A9) + R2 全部 4 片 (12,000 A9)
    expect(totalSupply(env)).toEqual(supBefore - 102000 * A9);
    expect(pstate(env).activeLockedRounds).toEqual(0 as uint128);

    expect(claim(env, alice, 1)).toHaveSuccessfulTx<TicketClaimReq>({ to: env.rc });
    expect(balanceOf(env, alice)).toEqual(70000 * A9);
}

// 9. 奖池耗尽触发 endAt、销毁剩余团队池并开启 30 天线性兜底解锁
get fun `test pool exhaustion triggers endAt and 30d linear fallback`() {
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

    val w10 = ticketData(env, whale, 10).weightRaw;
    expect(preview(env, 10, w10).unlockedLockedRaw).toEqual(0 as uint128);

    testing.setNow((ps.endAt + (FALLBACK as uint64) / 2) as uint32);
    expect(preview(env, 10, w10).unlockedLockedRaw).toEqual((210000000 * A9) as uint128);

    testing.setNow((ps.endAt + (FALLBACK as uint64)) as uint32);
    expect(preview(env, 10, w10).unlockedLockedRaw).toEqual((420000000 * A9) as uint128);
}

// 10. 跨越 255 -> 256 轮边界验证 uint32 轮次、独立凭证地址与 uint128 锁定槽位
get fun `test round 255 to 256 preserves tickets and locked rewards`() {
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
    expect(pstate(env).activeLockedRounds).toEqual(255 as uint128);

    expect(openRound(env, 232000, 464000)).toHaveSuccessfulTx<OpenRound>({ to: env.rc });
    expect(pstate(env).currentRoundId).toEqual(256 as uint32);
    stake(env, alice, 256, 10000 * A9);
    expect(ticketOf(env, alice, 255) != ticketOf(env, alice, 256)).toEqual(true);
    expect(ticketData(env, alice, 256).roundId).toEqual(256 as uint32);
    expect(settleRound(env, 256, 24)).toHaveSuccessfulTx<SettleRound>({ to: env.rc });
    expect(pstate(env).activeLockedRounds).toEqual((255 | (256 << 32)) as uint128);
    expect(round(env, 255).unlockedSlices).toEqual(1 as uint8);

    expect(claim(env, alice, 255)).toHaveSuccessfulTx<TicketClaimReq>({ to: env.rc });
    expect(claim(env, alice, 256)).toHaveSuccessfulTx<TicketClaimReq>({ to: env.rc });
    expect(balanceOf(env, alice)).toEqual(110000 * A9);
}

// 11. 零质押达标不推进胜场、不解锁锁定切片、不刷新 90 天停滞计时且 100% 滚存预算
get fun `test zero stake win does not increment successCount or unlock slices`() {
    val env = setup();
    expect(openRound(env, 0, P0 * 2)).toHaveSuccessfulTx<OpenRound>({ to: env.rc });
    val alice = user(env, "zs-alice", 10000 * A9);
    stake(env, alice, 1, 10000 * A9);
    expect(settleRound(env, 1, 24)).toHaveSuccessfulTx<SettleRound>({ to: env.rc });

    val psAfterR1 = pstate(env);
    expect(psAfterR1.successCount).toEqual(1 as uint32);
    expect(round(env, 1).unlockedSlices).toEqual(0 as uint8);
    expect(round(env, 1).lockedSlices).toEqual(4 as uint8);

    // 第 2 轮零质押但达标 -> 不推进胜场/解锁/停滞时钟，奖池与团队额度全额滚存
    expect(openRound(env, 232000, 464000)).toHaveSuccessfulTx<OpenRound>({ to: env.rc });
    val teamWalletBefore = balanceOf(env, env.teamWallet);
    expect(settleRound(env, 2, 24)).toHaveSuccessfulTx<SettleRound>({ to: env.rc });

    val psAfterR2 = pstate(env);
    val r2 = round(env, 2);
    expect(r2.status).toEqual(STATUS_SUCCEEDED);
    expect(r2.rewardBudgetRaw).toEqual(0 as uint128);
    expect(r2.immediateBps).toEqual(0 as uint16);
    expect(r2.lockedSlices).toEqual(0 as uint8);
    expect(psAfterR2.successCount).toEqual(1 as uint32);
    expect(psAfterR2.lastSuccessAt).toEqual(psAfterR1.lastSuccessAt);
    expect(round(env, 1).unlockedSlices).toEqual(0 as uint8);
    expect(psAfterR2.carryRaw).toEqual(psAfterR1.carryRaw + ROUND_REWARD);
    expect(psAfterR2.teamCarryRaw).toEqual(psAfterR1.teamCarryRaw + TEAM_ROUND);
    expect(balanceOf(env, env.teamWallet)).toEqual(teamWalletBefore);
}

// 12. 失败轮对累积团队滚存 teamCarryRaw 执行 50% 对称销毁且保持总量守恒
get fun `test failed round symmetrically burns half of teamCarryRaw`() {
    val env = setup();
    expect(openRound(env, 0, P0 * 2)).toHaveSuccessfulTx<OpenRound>({ to: env.rc });
    val alice = user(env, "tc-alice", 2000 * A9);
    stake(env, alice, 1, 2000 * A9);
    expect(settleRound(env, 1, 16)).toHaveSuccessfulTx<SettleRound>({ to: env.rc });

    val psR1 = pstate(env);
    expect(psR1.teamCarryRaw > 0).toEqual(true);
    val expectedTeamCarryBurn = psR1.teamCarryRaw / 2;

    expect(openRound(env, 232000, 464000)).toHaveSuccessfulTx<OpenRound>({ to: env.rc });
    val r2Budget = round(env, 2).rewardBudgetRaw as coins;
    val supBeforeFail = totalSupply(env);
    expect(settleRound(env, 2, 10)).toHaveSuccessfulTx<SettleRound>({ to: env.rc });

    val psR2 = pstate(env);
    expect(round(env, 1).burnedSlices).toEqual(1 as uint8);
    expect(psR2.teamCarryRaw).toEqual(psR1.teamCarryRaw - expectedTeamCarryBurn);
    expect(totalSupply(env)).toEqual(supBeforeFail - (r2Budget / 2) - (TEAM_ROUND as coins) - (expectedTeamCarryBurn as coins) - 6000 * A9);
}
