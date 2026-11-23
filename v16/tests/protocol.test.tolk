// A9 Protocol v16 — Comprehensive unit test suite covering all core rules and edge cases.
import "@acton/emulation/network"
import "@acton/emulation/testing"
import "@acton/testing/expect"
import "@acton/types/message"
import "@contracts/types"
import "@contracts/ticket"
import "helpers"

// 1. OpenRound authorization & [1.5x, 2.5x] dynamic corridor
get fun `test open round corridor and access control`() {
    val env = setup();
    val stranger = testing.treasury("stranger").address;

    // Non-opener rejected
    expect(net.send(stranger, createMessage({
        bounce: true,
        value: ton("0.1"),
        dest: env.rc,
        body: OpenRound { queryId: 1, twap24hUsdE8: 0, targetPriceUsdE8: P0 * 2 },
    }))).toHaveFailedTx<OpenRound>({ to: env.rc, exitCode: Errors.Unauthorized });

    // Below 1.5x rejected (P0 = 116000 -> min = 174000, max = 290000)
    expect(openRound(env, 0, 173999)).toHaveFailedTx<OpenRound>({ to: env.rc, exitCode: Errors.BadTargetPrice });
    // Above 2.5x rejected
    expect(openRound(env, 0, 290001)).toHaveFailedTx<OpenRound>({ to: env.rc, exitCode: Errors.BadTargetPrice });

    // Exact 1.5x succeeds for Round 1 (twap24h == 0 falls back to P0)
    expect(openRound(env, 0, 174000)).toHaveSuccessfulTx<OpenRound>({ to: env.rc });
    val r1 = round(env, 1);
    expect(r1.status).toEqual(STATUS_ACTIVE);
    expect(r1.targetPriceUsdE8).toEqual(174000 as uint128);
    expect(r1.rewardBudgetRaw).toEqual(ROUND_REWARD);

    // Cannot open Round 2 while Round 1 is active
    expect(openRound(env, 200000, 400000)).toHaveFailedTx<OpenRound>({ to: env.rc, exitCode: Errors.BadRoundStatus });
}

// 2. Early-bird weights (2.0x / 1.4x / 1.0x), multi-deposit accumulation, and beneficiary staking
get fun `test early bird weights and beneficiary staking`() {
    val env = setup();
    expect(openRound(env, 0, P0 * 2)).toHaveSuccessfulTx<OpenRound>({ to: env.rc });
    val r1 = round(env, 1);
    val third = (STAKE_WINDOW / 3) as uint64;

    val alice = user(env, "eb-alice", 20000 * A9);
    val bob = user(env, "eb-bob", 10000 * A9);
    val carol = user(env, "eb-carol", 10000 * A9);
    val dave = testing.treasury("eb-dave").address;

    // 1st third (2.0x): Alice stakes 10,000 -> weight 20,000
    stake(env, alice, 1, 10000 * A9);
    // 2nd third (1.4x): Bob stakes 10,000 -> weight 14,000; Alice stakes 5,000 for Dave -> weight 7,000
    testing.setNow((r1.stakeOpenAt + third) as uint32);
    stake(env, bob, 1, 10000 * A9);
    stakeFor(env, alice, dave, 1, 5000 * A9);
    // 3rd third (1.0x): Carol stakes 10,000 -> weight 10,000; Alice adds 5,000 -> +5,000 weight
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

// 3. Invalid deposits are instantly refunded via standard TEP-74 transfer
get fun `test invalid deposits are instantly refunded`() {
    val env = setup();
    expect(openRound(env, 0, P0 * 2)).toHaveSuccessfulTx<OpenRound>({ to: env.rc });
    val alice = user(env, "ref-alice", 10000 * A9);

    // Below minStake (500 A9 < 1,000 A9) -> instant refund
    stake(env, alice, 1, 500 * A9);
    expect(balanceOf(env, alice)).toEqual(10000 * A9);
    expect(round(env, 1).totalStakeRaw).toEqual(0 as uint128);

    // Wrong roundId (2 != 1) -> instant refund
    stake(env, alice, 2, 2000 * A9);
    expect(balanceOf(env, alice)).toEqual(10000 * A9);

    // Bad payload -> instant refund
    transfer(alice, walletOf(env.master, alice), env.rc, 2000 * A9, ton("0.15"), emptyPayload(), ton("0.3"));
    expect(balanceOf(env, alice)).toEqual(10000 * A9);

    // Real v15 stake payload (OP_STAKE_DEPOSIT_V15 = 0x5254000F + uint8 roundId + addr_none) -> full refund & zero ticket deployed
    val v15Body = beginCell()
        .storeUint(0x5254000F, 32)
        .storeUint(1, 8)
        .storeUint(0, 2)
        .endCell();
    val v15Payload = beginCell().storeUint(1, 1).storeRef(v15Body).toSlice();
    transfer(alice, walletOf(env.master, alice), env.rc, 2000 * A9, ton("0.15"), v15Payload, ton("0.3"));
    expect(balanceOf(env, alice)).toEqual(10000 * A9);
    expect(round(env, 1).totalStakeRaw).toEqual(0 as uint128);
    expect(round(env, 1).stakeCount).toEqual(0 as uint32);
    expect(testing.getAccountState(ticketOf(env, alice, 1)) == null).toEqual(true);

    // After staking window closes -> instant refund
    testing.setNow(round(env, 1).stakeCloseAt as uint32);
    stake(env, alice, 1, 2000 * A9);
    expect(balanceOf(env, alice)).toEqual(10000 * A9);
}

// 4. 15x cap, carry rollover, proportional team release & teamCarryRaw
get fun `test 15x cap and proportional team release`() {
    val env = setup();
    expect(openRound(env, 0, P0 * 2)).toHaveSuccessfulTx<OpenRound>({ to: env.rc });
    val alice = user(env, "cap-alice", 2000 * A9);
    stake(env, alice, 1, 2000 * A9);

    // Settle win: distributable = min(700M, 2000 * 15) = 30,000 A9
    expect(settleRound(env, 1, 16)).toHaveSuccessfulTx<SettleRound>({ to: env.rc });
    val r1 = round(env, 1);
    expect(r1.status).toEqual(STATUS_SUCCEEDED);
    expect(r1.rewardBudgetRaw).toEqual((30000 * A9) as uint128);

    val ps = pstate(env);
    expect(ps.carryRaw).toEqual(ROUND_REWARD - (30000 * A9 as uint128));
    // Team released = floor(120,000,000 * 30,000 / 700,000,000) = 5,142.857142857 A9
    val expectedTeam: coins = 5142857142857;
    expect(balanceOf(env, env.teamWallet)).toEqual(expectedTeam);
    expect(ps.teamCarryRaw).toEqual(TEAM_ROUND - (expectedTeam as uint128));
}

// 5. Tier 1 (Wins 1-5: 20% + 4x20%), symmetric failure burn, neutral abort, and bounce recovery on empty claim
get fun `test tier 1 unlock symmetric failure burn neutral abort and claim bounce`() {
    val env = setup();
    expect(openRound(env, 0, P0 * 2)).toHaveSuccessfulTx<OpenRound>({ to: env.rc });
    val alice = user(env, "t1-alice", 10000 * A9);
    stake(env, alice, 1, 10000 * A9);

    // Win #1: distributable = 150,000 -> 20% (30,000) immediate + 4 x 30,000 locked
    expect(settleRound(env, 1, 20)).toHaveSuccessfulTx<SettleRound>({ to: env.rc });
    expect(claim(env, alice, 1)).toHaveSuccessfulTx<TicketClaimReq>({ to: env.rc });
    expect(balanceOf(env, alice)).toEqual(40000 * A9); // 10,000 principal + 30,000 imm

    // Second claim immediately has nothing new -> bounces back and clears pending!
    expect(claim(env, alice, 1)).toHaveFailedTx<TicketClaimReq>({ to: env.rc, exitCode: Errors.NothingToClaim });
    expect(ticketData(env, alice, 1).pending).toEqual(false);

    // Round 2 wins -> unlocks 1st slice (30,000 A9)
    expect(openRound(env, 232000, 464000)).toHaveSuccessfulTx<OpenRound>({ to: env.rc });
    expect(settleRound(env, 2, 16)).toHaveSuccessfulTx<SettleRound>({ to: env.rc });
    expect(round(env, 1).unlockedSlices).toEqual(1 as uint8);
    expect(claim(env, alice, 1)).toHaveSuccessfulTx<TicketClaimReq>({ to: env.rc });
    expect(balanceOf(env, alice)).toEqual(70000 * A9);

    // Round 3 fails -> burns R3 half budget + R3 team + R1's 1 slice (30,000 A9)
    expect(openRound(env, 232000, 464000)).toHaveSuccessfulTx<OpenRound>({ to: env.rc });
    val r3Budget = round(env, 3).rewardBudgetRaw as coins;
    val supBeforeFail = totalSupply(env);
    expect(settleRound(env, 3, 15)).toHaveSuccessfulTx<SettleRound>({ to: env.rc });
    expect(round(env, 1).burnedSlices).toEqual(1 as uint8);
    expect(totalSupply(env)).toEqual(supBeforeFail - (r3Budget / 2) - (TEAM_ROUND as coins) - 30000 * A9);

    // Round 4 aborts (keeper offline past abortTimeout) -> neutral to R1 slices
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
    // Bob recovers 100% principal from aborted Round 4
    expect(claim(env, bob, 4)).toHaveSuccessfulTx<TicketClaimReq>({ to: env.rc });
    expect(balanceOf(env, bob)).toEqual(5000 * A9);

    // Rounds 5 & 6 win -> unlock remaining 2 slices of R1 (60,000 A9)
    expect(openRound(env, 232000, 464000)).toHaveSuccessfulTx<OpenRound>({ to: env.rc });
    expect(settleRound(env, 5, 24)).toHaveSuccessfulTx<SettleRound>({ to: env.rc });
    expect(openRound(env, 232000, 464000)).toHaveSuccessfulTx<OpenRound>({ to: env.rc });
    expect(settleRound(env, 6, 24)).toHaveSuccessfulTx<SettleRound>({ to: env.rc });

    expect(claim(env, alice, 1)).toHaveSuccessfulTx<TicketClaimReq>({ to: env.rc });
    // Total: 10,000 principal + 30,000 imm + 3 * 30,000 unlocked = 130,000 A9 (30,000 burned by R3)
    expect(balanceOf(env, alice)).toEqual(130000 * A9);
}

// 6. Tier 2 (Wins 6-10: 40% + 2x30%) & Tier 3 (Win 11+: 100% immediate, open-ended > 10 rounds)
get fun `test tier 2 and tier 3 beyond round 10`() {
    val env = setup();
    var r: uint32 = 1;
    while (r <= 5) {
        expect(openRound(env, r == 1 ? (0 as uint128) : (232000 as uint128), r == 1 ? ((P0 * 2) as uint128) : (464000 as uint128))).toHaveSuccessfulTx<OpenRound>({ to: env.rc });
        expect(settleRound(env, r, 24)).toHaveSuccessfulTx<SettleRound>({ to: env.rc });
        r += 1;
    }

    // Win #6 (Tier 2): 40% (60,000) imm + 2 x 30% (45,000)
    val bob = user(env, "t2-bob", 10000 * A9);
    expect(openRound(env, 232000, 464000)).toHaveSuccessfulTx<OpenRound>({ to: env.rc });
    stake(env, bob, 6, 10000 * A9);
    expect(settleRound(env, 6, 24)).toHaveSuccessfulTx<SettleRound>({ to: env.rc });
    expect(round(env, 6).immediateBps).toEqual(4000 as uint16);
    expect(round(env, 6).lockedSlices).toEqual(2 as uint8);
    expect(claim(env, bob, 6)).toHaveSuccessfulTx<TicketClaimReq>({ to: env.rc });
    expect(balanceOf(env, bob)).toEqual(70000 * A9);

    // Wins #7..#10
    while (r <= 10) {
        if (r > 6) {
            expect(openRound(env, 232000, 464000)).toHaveSuccessfulTx<OpenRound>({ to: env.rc });
            expect(settleRound(env, r, 24)).toHaveSuccessfulTx<SettleRound>({ to: env.rc });
        }
        r += 1;
    }
    expect(claim(env, bob, 6)).toHaveSuccessfulTx<TicketClaimReq>({ to: env.rc });
    expect(balanceOf(env, bob)).toEqual(160000 * A9);

    // Win #11 (Tier 3): 100% immediate, 0 locked slices!
    val carol = user(env, "t3-carol", 10000 * A9);
    expect(openRound(env, 232000, 464000)).toHaveSuccessfulTx<OpenRound>({ to: env.rc });
    stake(env, carol, 11, 10000 * A9);
    expect(settleRound(env, 11, 24)).toHaveSuccessfulTx<SettleRound>({ to: env.rc });
    expect(round(env, 11).immediateBps).toEqual(10000 as uint16);
    expect(round(env, 11).lockedSlices).toEqual(0 as uint8);
    expect(claim(env, carol, 11)).toHaveSuccessfulTx<TicketClaimReq>({ to: env.rc });
    expect(balanceOf(env, carol)).toEqual(160000 * A9);
}

// 7. Failed round burns 100% principal; staker cannot claim
get fun `test failed round burns 100pct principal`() {
    val env = setup();
    expect(openRound(env, 0, P0 * 2)).toHaveSuccessfulTx<OpenRound>({ to: env.rc });
    val alice = user(env, "fail-alice", 10000 * A9);
    stake(env, alice, 1, 10000 * A9);

    val supBefore = totalSupply(env);
    expect(settleRound(env, 1, 10)).toHaveSuccessfulTx<SettleRound>({ to: env.rc });
    expect(round(env, 1).status).toEqual(STATUS_FAILED);
    // Burned = 350M (half budget) + 10,000 (principal) + 120M (team)
    expect(totalSupply(env)).toEqual(supBefore - (ROUND_REWARD as coins / 2) - 10000 * A9 - (TEAM_ROUND as coins));
    expect(claim(env, alice, 1)).toHaveFailedTx<TicketClaimReq>({ to: env.rc, exitCode: Errors.NothingToClaim });
    expect(ticketData(env, alice, 1).pending).toEqual(false);
}

// 8. 90-day inactivity burn destroys unresolved slices and preserves already-unlocked rewards
get fun `test 90d inactivity burn preserves already unlocked rewards`() {
    val env = setup();
    expect(openRound(env, 0, P0 * 2)).toHaveSuccessfulTx<OpenRound>({ to: env.rc });
    val alice = user(env, "inact-alice", 10000 * A9);
    stake(env, alice, 1, 10000 * A9);
    expect(settleRound(env, 1, 24)).toHaveSuccessfulTx<SettleRound>({ to: env.rc });

    // Win #2 unlocks 1 slice (30,000 A9), 3 slices (90,000 A9) remain unresolved
    expect(openRound(env, 232000, 464000)).toHaveSuccessfulTx<OpenRound>({ to: env.rc });
    expect(settleRound(env, 2, 24)).toHaveSuccessfulTx<SettleRound>({ to: env.rc });

    val ps = pstate(env);
    val burnMsg = createMessage({ bounce: true, value: ton("0.2"), dest: env.rc, body: BurnInactiveLocked { queryId: 9 } });

    testing.setNow((ps.lastSuccessAt + (INACTIVITY_BURN as uint64) - 1) as uint32);
    expect(net.send(env.treasury, burnMsg)).toHaveFailedTx<BurnInactiveLocked>({ to: env.rc, exitCode: Errors.TooEarly });

    val supBefore = totalSupply(env);
    testing.setNow((ps.lastSuccessAt + (INACTIVITY_BURN as uint64)) as uint32);
    expect(net.send(env.treasury, burnMsg)).toHaveSuccessfulTx<BurnInactiveLocked>({ to: env.rc });
    expect(totalSupply(env)).toEqual(supBefore - 90000 * A9);
    expect(pstate(env).activeLockedRounds).toEqual(0 as uint32);

    // Alice still claims principal (10k) + imm (30k) + 1 unlocked slice (30k) = 70k
    expect(claim(env, alice, 1)).toHaveSuccessfulTx<TicketClaimReq>({ to: env.rc });
    expect(balanceOf(env, alice)).toEqual(70000 * A9);
}

// 9. Pool exhaustion triggers endAt, burns remaining team pools, blocks new rounds, and runs 30d linear fallback
get fun `test pool exhaustion triggers endAt and 30d linear fallback`() {
    val env = setup();
    val whale = user(env, "whale", 500000000 * A9);
    val bigStake = 50000000 * A9; // 15x = 750M >= 700M

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

    // Cannot open Round 11
    expect(openRound(env, 232000, 464000)).toHaveFailedTx<OpenRound>({ to: env.rc, exitCode: Errors.ProtocolEnded });

    // Round 10 (Win #10, Tier 2): 40% (280M) imm + 60% (420M) locked; linear over 30d
    val w10 = ticketData(env, whale, 10).weightRaw;
    expect(preview(env, 10, w10).unlockedLockedRaw).toEqual(0 as uint128);

    testing.setNow((ps.endAt + (FALLBACK as uint64) / 2) as uint32);
    expect(preview(env, 10, w10).unlockedLockedRaw).toEqual((210000000 * A9) as uint128);

    testing.setNow((ps.endAt + (FALLBACK as uint64)) as uint32);
    expect(preview(env, 10, w10).unlockedLockedRaw).toEqual((420000000 * A9) as uint128);
}

// Keep rewards rolling through aborted rounds, then exercise both sides of the old limit.
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
