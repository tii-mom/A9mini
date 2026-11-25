// A9 协议 v17.0 — 涨价解锁（Price-Unlock）全量安全、边界与资产守恒单元测试套件
import "@acton/build"
import "@acton/emulation/network"
import "@acton/emulation/testing"
import "@acton/testing/expect"
import "@acton/types/message"
import "@acton/types/transaction"
import "@contracts/jetton/storage"
import "@contracts/types"
import "helpers"

// 1. OpenRound 权限控制与 [1.30x, 2.00x] 动态价格走廊
get fun `test open round corridor 1.30x to 2.00x and access control`() {
    val env = setup();
    val stranger = testing.treasury("v17-stranger").address;

    expect(net.send(stranger, createMessage({
        bounce: true,
        value: ton("0.1"),
        dest: env.rc,
        body: OpenRound { queryId: 1, twap24hUsdE8: 0, targetPriceUsdE8: 150800 },
    }))).toHaveFailedTx<OpenRound>({ to: env.rc, exitCode: Errors.Unauthorized });

    // P0 = 116000 -> 1.30x = 150800, 2.00x = 232000
    expect(openRound(env, 0, 150799)).toHaveFailedTx<OpenRound>({ to: env.rc, exitCode: Errors.BadTargetPrice });
    expect(openRound(env, 0, 232001)).toHaveFailedTx<OpenRound>({ to: env.rc, exitCode: Errors.BadTargetPrice });

    expect(openRound(env, 0, 150800)).toHaveSuccessfulTx<OpenRound>({ to: env.rc });
    val r1 = round(env, 1);
    expect(r1.status).toEqual(STATUS_ACTIVE);
    expect(r1.targetPriceUsdE8).toEqual(150800 as uint128);
    expect(r1.rewardBudgetRaw).toEqual(ROUND_REWARD);
    expect(r1.vestingSeconds).toEqual(VESTING_SECONDS);
    expect(r1.earlyWindowSeconds).toEqual(EARLY_WINDOW);

    expect(openRound(env, 200000, 260000)).toHaveFailedTx<OpenRound>({ to: env.rc, exitCode: Errors.BadRoundStatus });
}

// 2. 头矿 6H 与 6H 后同地址追加分账（防“头矿 100 占坑 + 尾盘追加白嫖 5% 止损”）与指定受益人
get fun `test first 6h split ledger anti-gaming and beneficiary staking`() {
    val env = setup();
    expect(openRound(env, 0, 150800)).toHaveSuccessfulTx<OpenRound>({ to: env.rc });
    val r1 = round(env, 1);

    val alice = user(env, "split-alice", 20000 * A9);
    val bob = user(env, "split-bob", 10000 * A9);
    val dave = testing.treasury("split-dave").address;

    // 头矿 6H 内：Alice 投 100 A9，Bob 投 2000 A9，Alice 代 Dave 投 500 A9
    stake(env, alice, 1, 100 * A9);
    stake(env, bob, 1, 2000 * A9);
    stakeFor(env, alice, dave, 1, 500 * A9);

    // 刚好跨越 6H（21600s）：Alice 追加 10,000 A9，必须记入 lateAmountRaw 而非 earlyAmountRaw
    testing.setNow((r1.stakeOpenAt + (EARLY_WINDOW as uint64)) as uint32);
    stake(env, alice, 1, 10000 * A9);

    val ta = ticketData(env, alice, 1);
    expect(ta.earlyAmountRaw).toEqual((100 * A9) as uint128);
    expect(ta.lateAmountRaw).toEqual((10000 * A9) as uint128);
    expect(ta.amountRaw).toEqual((10100 * A9) as uint128);

    val tb = ticketData(env, bob, 1);
    expect(tb.earlyAmountRaw).toEqual((2000 * A9) as uint128);
    expect(tb.lateAmountRaw).toEqual(0 as uint128);

    val td = ticketData(env, dave, 1);
    expect(td.earlyAmountRaw).toEqual((500 * A9) as uint128);

    val rd = round(env, 1);
    expect(rd.totalStakeRaw).toEqual((12600 * A9) as uint128);
    expect(rd.earlyStakeRaw).toEqual((2600 * A9) as uint128);
    expect(rd.stakeCount).toEqual(4 as uint32);

    // 未通关（7/12 < 8）：检验精准分段止损退本（头矿 95% + 普通 90%）与总供应守恒
    val supplyBefore = totalSupply(env);
    expect(settleRound(env, 1, 7)).toHaveSuccessfulTx<SettleRound>({ to: env.rc });

    // Alice 应退：100*95% + 10000*90% = 95 + 9000 = 9095 A9（而非 10100*95% = 9595 A9）
    val aliceBalBefore = balanceOf(env, alice);
    expect(claim(env, alice, 1)).toHaveSuccessfulTx<TicketClaim>({ to: ticketOf(env, alice, 1) });
    expect(balanceOf(env, alice) - aliceBalBefore).toEqual(9095 * A9);

    // Bob 应退：2000*95% = 1900 A9
    val bobBalBefore = balanceOf(env, bob);
    expect(claim(env, bob, 1)).toHaveSuccessfulTx<TicketClaim>({ to: ticketOf(env, bob, 1) });
    expect(balanceOf(env, bob) - bobBalBefore).toEqual(1900 * A9);

    // Dave 应退：500*95% = 475 A9
    expect(claim(env, dave, 1)).toHaveSuccessfulTx<TicketClaim>({ to: ticketOf(env, dave, 1) });
    expect(balanceOf(env, dave)).toEqual(475 * A9);

    // 重复领奖必须失败且自动解除 pending 锁
    expect(claim(env, alice, 1)).toHaveFailedTx<TicketClaimReq>({ to: env.rc, exitCode: Errors.NothingToClaim });
    expect(ticketData(env, alice, 1).pending).toEqual(false);

    // 总销毁校验：半池 350M + 团队基额 120M + 本金止损 (2600*5% + 10000*10% = 130 + 1000 = 1130 A9)
    val expectedBurn = ((ROUND_REWARD / 2) + TEAM_ROUND + (1130 * A9 as uint128)) as coins;
    expect(supplyBefore - totalSupply(env)).toEqual(expectedBurn);
}

// 3. 24H 锁仓期提前解押 (85% 退本 / 15% 销毁)、12H 冲价期禁出 (Errors.LockClosed) 与同轮重入零吞币
get fun `test early exit in lock window, blocked in push window, and re-entry`() {
    val env = setup();
    expect(openRound(env, 0, 150800)).toHaveSuccessfulTx<OpenRound>({ to: env.rc });
    val r1 = round(env, 1);

    val alice = user(env, "ee-alice", 10000 * A9);
    val bob = user(env, "ee-bob", 10000 * A9);

    // 头矿内 Alice 锁 2000，Bob 锁 3000
    stake(env, alice, 1, 2000 * A9);
    stake(env, bob, 1, 3000 * A9);

    // Alice 在锁仓期内提前解押：退 85% (1700)，销毁 15% (300)
    val supBefore = totalSupply(env);
    val aliceBefore = balanceOf(env, alice);
    expect(earlyExit(env, alice, 1)).toHaveSuccessfulTx<TicketEarlyExit>({ to: ticketOf(env, alice, 1) });
    expect(balanceOf(env, alice) - aliceBefore).toEqual(1700 * A9);
    expect(supBefore - totalSupply(env)).toEqual(300 * A9);

    val taAfter = ticketData(env, alice, 1);
    expect(taAfter.exited).toEqual(true);
    expect(taAfter.amountRaw).toEqual(0 as uint128);
    expect(taAfter.earlyAmountRaw).toEqual(0 as uint128);
    expect(taAfter.pending).toEqual(false);

    val rdMid = round(env, 1);
    expect(rdMid.totalStakeRaw).toEqual((3000 * A9) as uint128);
    expect(rdMid.earlyStakeRaw).toEqual((3000 * A9) as uint128);

    // Alice 锁仓期后半段后悔重新入池 1000 A9（记入 lateAmountRaw，exited 自动复位 false，绝不吞币）
    testing.setNow((r1.stakeOpenAt + (EARLY_WINDOW as uint64) + 100) as uint32);
    stake(env, alice, 1, 1000 * A9);
    val taRe = ticketData(env, alice, 1);
    expect(taRe.exited).toEqual(false);
    expect(taRe.earlyAmountRaw).toEqual(0 as uint128);
    expect(taRe.lateAmountRaw).toEqual((1000 * A9) as uint128);

    // 进入 12H 冲价期（now >= stakeCloseAt）：封盘禁进禁出，Bob 提前解押必须抛 Errors.LockClosed 并自动解锁 pending
    testing.setNow(r1.stakeCloseAt as uint32);
    expect(earlyExit(env, bob, 1)).toHaveFailedTx<TicketEarlyExitReq>({ to: env.rc, exitCode: Errors.LockClosed });
    expect(ticketData(env, bob, 1).pending).toEqual(false);
    expect(ticketData(env, bob, 1).amountRaw).toEqual((3000 * A9) as uint128);
}

// 4. 所有人提前解押变空轮 -> 100% 滚存零销毁
get fun `test all early exited becomes empty round with zero burn`() {
    val env = setup();
    expect(openRound(env, 0, 150800)).toHaveSuccessfulTx<OpenRound>({ to: env.rc });
    val alice = user(env, "empty-ee-alice", 2000 * A9);
    stake(env, alice, 1, 1000 * A9);
    expect(earlyExit(env, alice, 1)).toHaveSuccessfulTx<TicketEarlyExit>({ to: ticketOf(env, alice, 1) });
    expect(round(env, 1).totalStakeRaw).toEqual(0 as uint128);

    val supBeforeSettle = totalSupply(env);
    expect(settleRound(env, 1, 5)).toHaveSuccessfulTx<SettleRound>({ to: env.rc });
    expect(totalSupply(env)).toEqual(supBeforeSettle);
    expect(pstate(env).carryRaw).toEqual(ROUND_REWARD);
    expect(pstate(env).teamCarryRaw).toEqual(TEAM_ROUND);
}

// 5. 全员 1:1 公平分奖、5x 封顶与超额 100% 滚存 + 团队池按实发比例释放
get fun `test 1to1 equal split, 5x cap, carry rollover and proportional team release`() {
    val env = setup();
    expect(openRound(env, 0, 150800)).toHaveSuccessfulTx<OpenRound>({ to: env.rc });
    val r1 = round(env, 1);

    val alice = user(env, "cap-alice", 1000 * A9);
    val bob = user(env, "cap-bob", 1000 * A9);
    // Alice 在头矿投 1000，Bob 在 6H 后投 1000 -> 通关后应 100% 等权平分，各得 5x = 5000 A9
    stake(env, alice, 1, 1000 * A9);
    testing.setNow((r1.stakeOpenAt + (EARLY_WINDOW as uint64) + 60) as uint32);
    stake(env, bob, 1, 1000 * A9);

    expect(settleRound(env, 1, 8)).toHaveSuccessfulTx<SettleRound>({ to: env.rc });
    val settled = round(env, 1);
    expect(settled.status).toEqual(STATUS_SUCCEEDED);
    // 总锁仓 2000 A9 × 5 = 10000 A9
    expect(settled.rewardBudgetRaw).toEqual((10000 * A9) as uint128);
    expect(pstate(env).carryRaw).toEqual(ROUND_REWARD - (10000 * A9 as uint128));

    val expectedTeam = ((TEAM_ROUND as int) * (10000 * A9 as int) / (ROUND_REWARD as int)) as coins;
    expect(balanceOf(env, env.teamWallet)).toEqual(expectedTeam);
    expect(pstate(env).teamCarryRaw).toEqual(TEAM_ROUND - (expectedTeam as uint128));

    // 两人的奖金预览完全相等：5000 A9（1000 即时 + 4000 锁 14 天）
    val pa = preview(env, 1, 1000 * A9 as uint128);
    expect(pa.totalRewardRaw).toEqual((5000 * A9) as uint128);
    expect(pa.immediateRaw).toEqual((1000 * A9) as uint128);
    expect(pa.lockedRaw).toEqual((4000 * A9) as uint128);
}

// 6. 20% 秒提 + 14 天逐秒线性释放（满 14 天全领）+ 满 14 天后误传 instantDiscount=true 零销毁边界！
get fun `test 14d linear vesting and post-14d instantDiscount zero burn boundary`() {
    val env = setup();
    expect(openRound(env, 0, 150800)).toHaveSuccessfulTx<OpenRound>({ to: env.rc });
    val alice = user(env, "vest-alice", 1000 * A9);
    val bob = user(env, "vest-bob", 1000 * A9);
    stake(env, alice, 1, 1000 * A9);
    stake(env, bob, 1, 1000 * A9);

    expect(settleRound(env, 1, 10)).toHaveSuccessfulTx<SettleRound>({ to: env.rc });
    val tSettle = round(env, 1).settledAt;

    // Day 0：Alice 常规领奖 -> 1000 本金 + 1000 秒提(20%) = 2000 A9
    expect(claim(env, alice, 1)).toHaveSuccessfulTx<TicketClaim>({ to: ticketOf(env, alice, 1) });
    expect(balanceOf(env, alice)).toEqual(2000 * A9);

    // Day 7 (刚好一半 604800s)：Alice 领一半锁仓 = 2000 A9
    testing.setNow((tSettle + (VESTING_SECONDS as uint64) / 2) as uint32);
    expect(claim(env, alice, 1)).toHaveSuccessfulTx<TicketClaim>({ to: ticketOf(env, alice, 1) });
    expect(balanceOf(env, alice)).toEqual(4000 * A9);

    // Day 14 满期后：
    testing.setNow((tSettle + (VESTING_SECONDS as uint64) + 10) as uint32);
    // 关键边界用例：Bob 从未领过，满 14 天后误传 instantDiscount = true -> 必须 100% 全额实发 6000 A9、0 销毁、forfeited=false！
    val supBeforeBob = totalSupply(env);
    expect(claimInstant(env, bob, 1)).toHaveSuccessfulTx<TicketClaim>({ to: ticketOf(env, bob, 1) });
    expect(balanceOf(env, bob)).toEqual(6000 * A9);
    expect(totalSupply(env)).toEqual(supBeforeBob);
    expect(ticketData(env, bob, 1).forfeited).toEqual(false);

    // Alice 满 14 天后误传 instantDiscount = true 领最后一半 2000 A9 -> 同样 0 销毁、100% 实发
    val supBeforeAlice = totalSupply(env);
    expect(claimInstant(env, alice, 1)).toHaveSuccessfulTx<TicketClaim>({ to: ticketOf(env, alice, 1) });
    expect(balanceOf(env, alice)).toEqual(6000 * A9);
    expect(totalSupply(env)).toEqual(supBeforeAlice);
    expect(ticketData(env, alice, 1).forfeited).toEqual(false);
}

// 7. 第 0 天 3 折急提 (44% 实发 / 56% 销毁) 与 第 7 天中途 3 折急提 (已解锁 100% + 未解锁 30/70)
get fun `test instant cashout day 0 (44/56) and mid-vesting day 7 (100% vested + 30/70 unvested)`() {
    val env = setup();
    expect(openRound(env, 0, 150800)).toHaveSuccessfulTx<OpenRound>({ to: env.rc });
    val alice = user(env, "ic-alice", 1000 * A9);
    val bob = user(env, "ic-bob", 1000 * A9);
    stake(env, alice, 1, 1000 * A9);
    stake(env, bob, 1, 1000 * A9);

    expect(settleRound(env, 1, 9)).toHaveSuccessfulTx<SettleRound>({ to: env.rc });
    val tSettle = round(env, 1).settledAt;
    // 每人总奖励 5000 A9 = 1000 即时 + 4000 锁仓

    // Alice 第 0 秒直接点 3 折急提：
    // 本金 1000 + 即时 1000 + 未解锁 4000*30% (1200) = 3200 A9（奖励实发 2200 = 44%）；销毁 4000*70% = 2800 A9 (56%)
    val sup0 = totalSupply(env);
    expect(claimInstant(env, alice, 1)).toHaveSuccessfulTx<TicketClaim>({ to: ticketOf(env, alice, 1) });
    expect(balanceOf(env, alice)).toEqual(3200 * A9);
    expect(sup0 - totalSupply(env)).toEqual(2800 * A9);
    expect(ticketData(env, alice, 1).forfeited).toEqual(true);
    expect(claim(env, alice, 1)).toHaveFailedTx<TicketClaimReq>({ to: env.rc, exitCode: Errors.NothingToClaim });

    // Bob 等到第 7 天（一半已自然解锁 2000，剩余未解锁 2000）才点 3 折急提：
    // 本金 1000 + 即时 1000 + 已解锁 2000 (100% 不打折) + 未解锁 2000*30% (600) = 4600 A9；销毁 2000*70% = 1400 A9
    testing.setNow((tSettle + (VESTING_SECONDS as uint64) / 2) as uint32);
    val sup7 = totalSupply(env);
    expect(claimInstant(env, bob, 1)).toHaveSuccessfulTx<TicketClaim>({ to: ticketOf(env, bob, 1) });
    expect(balanceOf(env, bob)).toEqual(4600 * A9);
    expect(sup7 - totalSupply(env)).toEqual(1400 * A9);
    expect(ticketData(env, bob, 1).forfeited).toEqual(true);
    expect(claimInstant(env, bob, 1)).toHaveFailedTx<TicketClaimReq>({ to: env.rc, exitCode: Errors.NothingToClaim });
}

// 8. 7 天超时 AbortRound 无许可逃生门：100% 无损退本（不扣 5%/10% 止损）
get fun `test 7d abort timeout full 100% principal refund without stop-loss`() {
    val env = setup();
    expect(openRound(env, 0, 150800)).toHaveSuccessfulTx<OpenRound>({ to: env.rc });
    val r1 = round(env, 1);
    val alice = user(env, "abort-alice", 5000 * A9);
    // 6H 后入池（普通 10% 止损档）
    testing.setNow((r1.stakeOpenAt + (EARLY_WINDOW as uint64) + 10) as uint32);
    stake(env, alice, 1, 5000 * A9);

    testing.setNow((r1.stakeCloseAt + (OBS_WINDOW as uint64) + (ABORT_TIMEOUT as uint64) - 1) as uint32);
    expect(net.send(alice, createMessage({
        bounce: true, value: ton("0.1"), dest: env.rc, body: AbortRound { queryId: 1 },
    }))).toHaveFailedTx<AbortRound>({ to: env.rc, exitCode: Errors.TooEarly });

    testing.setNow((r1.stakeCloseAt + (OBS_WINDOW as uint64) + (ABORT_TIMEOUT as uint64)) as uint32);
    expect(net.send(alice, createMessage({
        bounce: true, value: ton("0.1"), dest: env.rc, body: AbortRound { queryId: 2 },
    }))).toHaveSuccessfulTx<AbortRound>({ to: env.rc });

    expect(round(env, 1).status).toEqual(STATUS_ABORTED);
    expect(pstate(env).carryRaw).toEqual(ROUND_REWARD);

    // 100% 退回 5000 A9
    expect(claim(env, alice, 1)).toHaveSuccessfulTx<TicketClaim>({ to: ticketOf(env, alice, 1) });
    expect(balanceOf(env, alice)).toEqual(5000 * A9);
}

// 9. 无效入金（<100 A9、错轮、畸形 anycast、封盘超时）即时退回，零吞币
get fun `test invalid deposits below 100 A9 or after close are refunded`() {
    val env = setup();
    expect(openRound(env, 0, 150800)).toHaveSuccessfulTx<OpenRound>({ to: env.rc });
    val alice = user(env, "ref-alice", 5000 * A9);

    // 低于 100 A9 最低门槛 -> 原路退回
    stake(env, alice, 1, 99 * A9);
    expect(balanceOf(env, alice)).toEqual(5000 * A9);
    expect(round(env, 1).totalStakeRaw).toEqual(0 as uint128);

    // 刚好 100 A9 最低门槛 -> 成功入池
    stake(env, alice, 1, 100 * A9);
    expect(balanceOf(env, alice)).toEqual(4900 * A9);
    expect(round(env, 1).totalStakeRaw).toEqual((100 * A9) as uint128);

    // 错轮 -> 退回
    stake(env, alice, 2, 500 * A9);
    expect(balanceOf(env, alice)).toEqual(4900 * A9);

    // 封盘超时 -> 退回
    testing.setNow(round(env, 1).stakeCloseAt as uint32);
    stake(env, alice, 1, 500 * A9);
    expect(balanceOf(env, alice)).toEqual(4900 * A9);
}

// 10. 整数取整守恒压力测试（奇数/质数金额多用户混合失败止损，绝不出现 1 raw 兑付缺口）
get fun `test failed round integer rounding solvency across odd multi-user stakes`() {
    val env = setup();
    expect(openRound(env, 0, 150800)).toHaveSuccessfulTx<OpenRound>({ to: env.rc });
    val r1 = round(env, 1);

    val u1 = user(env, "odd-u1", 200 * A9);
    val u2 = user(env, "odd-u2", 200 * A9);
    val u3 = user(env, "odd-u3", 200 * A9);
    // 刻意用带奇数尾数的 raw 金额
    val s1: coins = (100 * A9) + 3333;
    val s2: coins = (100 * A9) + 7777;
    val s3: coins = (100 * A9) + 9999;

    stake(env, u1, 1, s1);
    stake(env, u2, 1, s2);
    testing.setNow((r1.stakeOpenAt + (EARLY_WINDOW as uint64) + 1) as uint32);
    stake(env, u3, 1, s3);

    expect(settleRound(env, 1, 3)).toHaveSuccessfulTx<SettleRound>({ to: env.rc });
    // 三人均必须全额领出各自应得退本，绝不因 1 raw 缺口失败
    expect(claim(env, u1, 1)).toHaveSuccessfulTx<TicketClaim>({ to: ticketOf(env, u1, 1) });
    expect(claim(env, u2, 1)).toHaveSuccessfulTx<TicketClaim>({ to: ticketOf(env, u2, 1) });
    expect(claim(env, u3, 1)).toHaveSuccessfulTx<TicketClaim>({ to: ticketOf(env, u3, 1) });
}

// 11. 连续轮次（第 1 关胜 + 第 2 关败 + 第 3 关胜），且前轮 14 天释放永久不倒扣
get fun `test multi-round progression preserves prior round 14d linear vesting`() {
    val env = setup();
    val alice = user(env, "multi-alice", 5000 * A9);

    // 第 1 关胜
    expect(openRound(env, 0, 150800)).toHaveSuccessfulTx<OpenRound>({ to: env.rc });
    stake(env, alice, 1, 1000 * A9);
    expect(settleRound(env, 1, 8)).toHaveSuccessfulTx<SettleRound>({ to: env.rc });
    val t1 = round(env, 1).settledAt;

    // 第 2 关败
    expect(openRound(env, 160000, 208000)).toHaveSuccessfulTx<OpenRound>({ to: env.rc });
    stake(env, alice, 2, 1000 * A9);
    expect(settleRound(env, 2, 4)).toHaveSuccessfulTx<SettleRound>({ to: env.rc });

    // 第 2 关失败不影响第 1 关的 14 天线性释放：满 14 天后第 1 关仍 100% 领满 6000 A9
    testing.setNow((t1 + (VESTING_SECONDS as uint64) + 60) as uint32);
    val bal0 = balanceOf(env, alice);
    expect(claim(env, alice, 1)).toHaveSuccessfulTx<TicketClaim>({ to: ticketOf(env, alice, 1) });
    expect(balanceOf(env, alice) - bal0).toEqual(6000 * A9);

    // 第 2 关头矿失败领回 95% = 950 A9
    val bal1 = balanceOf(env, alice);
    expect(claim(env, alice, 2)).toHaveSuccessfulTx<TicketClaim>({ to: ticketOf(env, alice, 2) });
    expect(balanceOf(env, alice) - bal1).toEqual(950 * A9);
}

// 12. 权限校验、Gas 不足校验与 RetrySettlePayouts 无待重试报错
get fun `test auth guards, dual-action gas checks and retry guard`() {
    val env = setup();
    expect(openRound(env, 0, 150800)).toHaveSuccessfulTx<OpenRound>({ to: env.rc });
    val alice = user(env, "guard-alice", 1000 * A9);
    val stranger = testing.treasury("guard-stranger").address;
    stake(env, alice, 1, 1000 * A9);

    // 提前解押 Gas 不足 0.34 GRAM 必须拒绝
    expect(net.send(alice, createMessage({
        bounce: true, value: ton("0.22"), dest: ticketOf(env, alice, 1), body: TicketEarlyExit { queryId: 9 },
    }))).toHaveFailedTx<TicketEarlyExit>({ to: ticketOf(env, alice, 1), exitCode: Errors.NotEnoughValue });

    // 非持有人提前解押必须拒绝
    expect(net.send(stranger, createMessage({
        bounce: true, value: ton("0.34"), dest: ticketOf(env, alice, 1), body: TicketEarlyExit { queryId: 10 },
    }))).toHaveFailedTx<TicketEarlyExit>({ to: ticketOf(env, alice, 1), exitCode: Errors.NotOwner });

    // 无滞留出账时调用 RetrySettlePayouts 抛 Errors.NothingToRetry
    expect(net.send(stranger, createMessage({
        bounce: true, value: ton("0.35"), dest: env.rc, body: RetrySettlePayouts { queryId: 11 },
    }))).toHaveFailedTx<RetrySettlePayouts>({ to: env.rc, exitCode: Errors.NothingToRetry });
}

// 13. P0 并发竞态测试：EarlyExit 在途期间若并发到达新 TicketAddStake，TicketConfirm 精确扣减不吞新锁仓
get fun `test concurrent TicketAddStake during in-flight EarlyExit preserves new stake`() {
    val env = setup();
    expect(openRound(env, 0, 150800)).toHaveSuccessfulTx<OpenRound>({ to: env.rc });
    val r1 = round(env, 1);
    val alice = user(env, "race-alice", 10000 * A9);

    // 1) 头矿 6H 内锁 1,000 A9，6H 后追加 500 A9
    stake(env, alice, 1, 1000 * A9);
    testing.setNow((r1.stakeOpenAt + (EARLY_WINDOW as uint64) + 60) as uint32);
    stake(env, alice, 1, 500 * A9);
    val ticketAddr = ticketOf(env, alice, 1);

    // 2) 模拟并发场景：EarlyExit(1000 early + 500 late) 的 TicketConfirm 尚在途中，
    //    用户又并发锁仓 2,000 A9（TicketAddStake 先行到达 StakeTicket）
    stake(env, alice, 1, 2000 * A9);
    val beforeConfirm = ticketData(env, alice, 1);
    expect(beforeConfirm.earlyAmountRaw).toEqual((1000 * A9) as uint128);
    expect(beforeConfirm.lateAmountRaw).toEqual((2500 * A9) as uint128);

    // 3) 随后来自 RoundController 的 TicketConfirm(exited=true, exitedEarlyRaw=1000, exitedLateRaw=500) 抵达：
    //    必须精确扣减旧解押额，完整保留并发新锁仓 2,000 A9，且 exited 保持 false
    expect(net.send(env.rc, createMessage({
        bounce: false,
        value: VALUE_TICKET_MSG,
        dest: ticketAddr,
        body: TicketConfirm {
            queryId: 901,
            principalDone: false,
            immediateClaimed: false,
            lockedClaimedRaw: 0,
            exited: true,
            forfeited: false,
            exitedEarlyRaw: (1000 * A9) as uint128,
            exitedLateRaw: (500 * A9) as uint128,
        },
    }))).toHaveSuccessfulTx<TicketConfirm>({ to: ticketAddr });

    val afterPartial = ticketData(env, alice, 1);
    expect(afterPartial.earlyAmountRaw).toEqual(0 as uint128);
    expect(afterPartial.lateAmountRaw).toEqual((2000 * A9) as uint128);
    expect(afterPartial.amountRaw).toEqual((2000 * A9) as uint128);
    expect(afterPartial.exited).toEqual(false);
    expect(afterPartial.pending).toEqual(false);

    // 4) 若后续再次把剩余 2,000 A9 也全部解押扣清，才置 exited = true
    expect(net.send(env.rc, createMessage({
        bounce: false,
        value: VALUE_TICKET_MSG,
        dest: ticketAddr,
        body: TicketConfirm {
            queryId: 902,
            principalDone: false,
            immediateClaimed: false,
            lockedClaimedRaw: 0,
            exited: true,
            forfeited: false,
            exitedEarlyRaw: 0 as uint128,
            exitedLateRaw: (2000 * A9) as uint128,
        },
    }))).toHaveSuccessfulTx<TicketConfirm>({ to: ticketAddr });

    val afterFull = ticketData(env, alice, 1);
    expect(afterFull.amountRaw).toEqual(0 as uint128);
    expect(afterFull.exited).toEqual(true);
}
