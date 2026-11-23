// A9 Protocol v16 — Comprehensive unit test suite covering all core rules and edge cases.
import "@acton/emulation/network"
import "@acton/emulation/testing"
import "@acton/testing/expect"
import "@acton/types/message"
import "@acton/types/transaction"
import "@contracts/jetton/storage"
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

// 11. W3: steady-state GC, forged ReturnExcesses immunity (P0-1), and anti-anycast/dust defenses (P1-1/P1-2)
get fun `test w3 steady state clears pending maps and blocks forged callbacks`() {
    val env = setup();
    expect(openRound(env, 0, P0 * 2)).toHaveSuccessfulTx<OpenRound>({ to: env.rc });
    val alice = user(env, "w3-steady-alice", 10000 * A9);
    val attacker = user(env, "w3-attacker", 100 * A9);

    stake(env, alice, 1, 5000 * A9);
    // TicketStakeAck immediately clears pendingStakes
    expect(recoveryMeta(env).hasPendingStakes).toEqual(false);

    expect(settleRound(env, 1, 20)).toHaveSuccessfulTx<SettleRound>({ to: env.rc });
    expect(claim(env, alice, 1)).toHaveSuccessfulTx<TicketClaimReq>({ to: env.rc });
    expect(balanceOf(env, alice)).toEqual(25000 * A9); // 5k unused + 5k principal + 15k (20% of 75k)
    expect(ticketData(env, alice, 1).pending).toEqual(false);
    expect(ticketData(env, alice, 1).principalDone).toEqual(true);
    expect(ticketData(env, alice, 1).immediateClaimed).toEqual(true);

    // P0-1 regression: attacker drives alice's own JettonWallet to send ReturnExcessesBack(opId) -> RC ignores harmlessly
    val predictedOpId = PENDING_OP_FLAG | recoveryMeta(env).nextOpId;
    net.send(attacker, createMessage({
        bounce: true,
        value: ton("0.1"),
        dest: walletOf(env.master, attacker),
        body: AskToTransferMsg {
            queryId: predictedOpId,
            jettonAmount: 1,
            transferRecipient: alice,
            sendExcessesTo: env.rc,
            customPayload: null,
            forwardTonAmount: 0,
            forwardPayload: emptyPayload(),
        },
    }));
    expect(ticketData(env, alice, 1).pending).toEqual(false);

    // O(1) lazy GC: after PENDING_GC_TTL (300s), next op prunes stale pendingClaims
    testing.setNow((round(env, 1).settledAt + PENDING_GC_TTL + 1) as uint32);
    expect(openRound(env, 232000, 464000)).toHaveSuccessfulTx<OpenRound>({ to: env.rc });
    stake(env, alice, 2, 1000 * A9);
    expect(recoveryMeta(env).hasPendingClaims).toEqual(false);
    expect(recoveryMeta(env).hasPendingStakes).toEqual(false);

    // P1-2 regression: malformed anycast=1 (0b101) beneficiary address does NOT throw/swallow A9; refunds cleanly
    val badAnycastBody = beginCell()
        .storeUint(OP_STAKE_DEPOSIT, 32)
        .storeUint(2, 32)
        .storeUint(0b101, 3)
        .storeUint(0, 200)
        .storeUint(0, 64)
        .endCell();
    val badAnycastPayload = beginCell().storeUint(1, 1).storeRef(badAnycastBody).toSlice();
    val balBeforeBad = balanceOf(env, alice);
    transfer(alice, walletOf(env.master, alice), env.rc, 1000 * A9, ton("0.15"), badAnycastPayload, ton("0.3"));
    expect(balanceOf(env, alice)).toEqual(balBeforeBad);

    // P1-1 regression: sub-1-A9 dust with <0.015 TON is ignored without bloating failedRefunds or draining RC GRAM
    val rcTonBeforeDust = testing.getAccountBalance(env.rc);
    transfer(attacker, walletOf(env.master, attacker), env.rc, 1, ton("0.001"), emptyPayload(), ton("0.1"));
    expect(failedRefundOf(env, attacker)).toEqual(0 as uint128);
    expect(testing.getAccountBalance(env.rc) >= rcTonBeforeDust - ton("0.02")).toEqual(true);
}

// 12. W3-3: low-gas invalid deposits escrow refunds instead of swallowing tokens or draining RC GRAM
get fun `test w3 low gas invalid deposit escrows refund and pull claim succeeds`() {
    val env = setup();
    expect(openRound(env, 0, P0 * 2)).toHaveSuccessfulTx<OpenRound>({ to: env.rc });
    val alice = user(env, "w3-lowgas-alice", 10000 * A9);
    val stranger = testing.treasury("w3-lowgas-stranger").address;
    val rcTonBefore = testing.getAccountBalance(env.rc);

    // 1) Invalid payload with low forwardTon (0.01 GRAM < MIN_REFUND_VALUE 0.08 GRAM) -> escrowed, NOT swallowed
    transfer(alice, walletOf(env.master, alice), env.rc, 2000 * A9, ton("0.01"), emptyPayload(), ton("0.15"));
    expect(balanceOf(env, alice)).toEqual(8000 * A9);
    expect(failedRefundOf(env, alice)).toEqual((2000 * A9) as uint128);
    // RC GRAM balance must NOT be drained by low-gas spam
    expect(testing.getAccountBalance(env.rc) >= rcTonBefore).toEqual(true);

    // 2) Second low-gas invalid deposit (below minStake 500 A9) accumulates cleanly into failedRefunds[alice]
    transfer(alice, walletOf(env.master, alice), env.rc, 500 * A9, ton("0.01"), stakePayload(1), ton("0.15"));
    expect(balanceOf(env, alice)).toEqual(7500 * A9);
    expect(failedRefundOf(env, alice)).toEqual((2500 * A9) as uint128);

    // 3) Pull claim with insufficient gas rejected and balance preserved
    expect(claimFailedRefund(env, alice, ton("0.05"))).toHaveFailedTx<ClaimFailedRefund>({ to: env.rc, exitCode: Errors.NotEnoughValue });
    expect(failedRefundOf(env, alice)).toEqual((2500 * A9) as uint128);

    // 4) Stranger with 0 escrowed refund rejected
    expect(claimFailedRefund(env, stranger, ton("0.15"))).toHaveFailedTx<ClaimFailedRefund>({ to: env.rc, exitCode: Errors.NothingToClaim });

    // 5) Alice pays own gas -> recovers full 2,500 A9
    expect(claimFailedRefund(env, alice, ton("0.15"))).toHaveSuccessfulTx<ClaimFailedRefund>({ to: env.rc });
    expect(balanceOf(env, alice)).toEqual(10000 * A9);
    expect(failedRefundOf(env, alice)).toEqual(0 as uint128);
}

// 13. W3-1: StakeTicket bounce rolls back round stake/weight/count and refunds user A9
get fun `test w3 stake ticket bounce rolls back round ledger and refunds user`() {
    val env = setup();
    expect(openRound(env, 0, P0 * 2)).toHaveSuccessfulTx<OpenRound>({ to: env.rc });
    val alice = user(env, "w3-sb-alice", 10000 * A9);
    val ticketAddr = ticketOf(env, alice, 1);

    // Step 1: deploy StakeTicket normally with 2,000 A9 so ticketAddr is active
    stake(env, alice, 1, 2000 * A9);
    expect(round(env, 1).totalStakeRaw).toEqual((2000 * A9) as uint128);
    expect(round(env, 1).stakeCount).toEqual(1 as uint32);

    // Step 2: simulate corrupted/incompatible state at ticketAddr so next TicketAddStake bounces natively in TVM!
    val origShard = testing.getShardAccount(ticketAddr)!;
    var brokenAcc = origShard.account.load();
    if (brokenAcc is TlbAccountInfo) {
        var st = brokenAcc.storage;
        if (st.state is TlbAccountStateActive) {
            var init = st.state.stateInit;
            init.data = beginCell().endCell(); // empty data causes TicketStorage.load() to throw cell underflow & bounce!
            st.state = TlbAccountStateActive { stateInit: init };
        }
        brokenAcc.storage = st;
    }
    testing.setShardAccount(ticketAddr, {
        account: brokenAcc.toCell(),
        lastTransHash: origShard.lastTransHash,
        lastTransLt: origShard.lastTransLt,
    });

    // Step 3: Alice stakes another 3,000 A9 -> RC optimistically adds then StakeTicket throws & bounces -> RC rolls back & refunds 3,000 A9!
    val balBefore = balanceOf(env, alice); // 8,000 A9
    stake(env, alice, 1, 3000 * A9);

    // Round ledger MUST be rolled back cleanly to 2,000 A9 / weight 4,000 A9 / stakeCount 1
    val rdAfter = round(env, 1);
    expect(rdAfter.totalStakeRaw).toEqual((2000 * A9) as uint128);
    expect(rdAfter.totalWeightRaw).toEqual((4000 * A9) as uint128);
    expect(rdAfter.stakeCount).toEqual(1 as uint32);
    // User MUST receive full 3,000 A9 back and pendingStakes MUST be cleared!
    expect(balanceOf(env, alice)).toEqual(balBefore);
    expect(recoveryMeta(env).hasPendingStakes).toEqual(false);
}

// 14. W3-2: Claim Jetton transfer bounce rolls back StakeTicket exact delta, and retry succeeds
get fun `test w3 claim and failed refund jetton bounce rollback preserves funds`() {
    // Deploy RC with 0 initial reward pool funding so claim payout (8,000 A9) exceeds rcWallet's 2,000 A9 balance
    val env = setupWithFunding(0);
    expect(openRound(env, 0, P0 * 2)).toHaveSuccessfulTx<OpenRound>({ to: env.rc });
    val alice = user(env, "w3-cb-alice", 5000 * A9);
    stake(env, alice, 1, 2000 * A9);

    // Settle Round 1 as win (distributable = 30,000 A9)
    expect(settleRound(env, 1, 20)).toHaveSuccessfulTx<SettleRound>({ to: env.rc });

    // Alice tries to claim 8,000 A9 (2,000 principal + 6,000 imm): rcWallet has only 2,000 A9 -> JettonWallet throws BalanceError & bounces!
    val balBeforeClaim = balanceOf(env, alice); // 3,000 A9
    claim(env, alice, 1);

    // CRITICAL W3-2 INVARIANT: TicketClaimRollback restores principalDone=false, immediateClaimed=false, pending=false!
    val tdAfterBounce = ticketData(env, alice, 1);
    expect(tdAfterBounce.pending).toEqual(false);
    expect(tdAfterBounce.principalDone).toEqual(false);
    expect(tdAfterBounce.immediateClaimed).toEqual(false);
    expect(tdAfterBounce.lockedClaimedRaw).toEqual(0 as uint128);
    expect(balanceOf(env, alice)).toEqual(balBeforeClaim);
    expect(recoveryMeta(env).hasPendingClaims).toEqual(false);

    // Also verify ClaimFailedRefund Jetton bounce preserves failedRefunds[alice]:
    val balBeforeLowGas = balanceOf(env, alice);
    transfer(alice, walletOf(env.master, alice), env.rc, 1000 * A9, ton("0.01"), emptyPayload(), ton("0.15"));
    expect(failedRefundOf(env, alice)).toEqual((1000 * A9) as uint128);
    val origRcW = testing.getShardAccount(env.rcWallet)!;
    var drainedRcW = origRcW.account.load();
    if (drainedRcW is TlbAccountInfo) {
        var st = drainedRcW.storage;
        if (st.state is TlbAccountStateActive) {
            var init = st.state.stateInit;
            var wData = WalletStorage.fromCell(init.data!);
            wData.jettonBalance = 0;
            init.data = wData.toCell();
            st.state = TlbAccountStateActive { stateInit: init };
        }
        drainedRcW.storage = st;
    }
    testing.setShardAccount(env.rcWallet, {
        account: drainedRcW.toCell(),
        lastTransHash: origRcW.lastTransHash,
        lastTransLt: origRcW.lastTransLt,
    });
    claimFailedRefund(env, alice, ton("0.15"));
    expect(failedRefundOf(env, alice)).toEqual((1000 * A9) as uint128);
    expect(recoveryMeta(env).hasPendingClaims).toEqual(false);

    // Top up RC reward pool from treasury -> BOTH claim retry (8,000 A9) & failed refund retry (1,000 A9) succeed!
    transfer(env.treasury, env.treasuryWallet, env.rc, RC_FUNDING, 0, emptyPayload(), ton("0.2"));
    expect(claim(env, alice, 1)).toHaveSuccessfulTx<TicketClaimReq>({ to: env.rc });
    expect(claimFailedRefund(env, alice, ton("0.15"))).toHaveSuccessfulTx<ClaimFailedRefund>({ to: env.rc });
    expect(balanceOf(env, alice)).toEqual(balBeforeLowGas + 8000 * A9);
    expect(failedRefundOf(env, alice)).toEqual(0 as uint128);
    val tdAfterRetry = ticketData(env, alice, 1);
    expect(tdAfterRetry.pending).toEqual(false);
    expect(tdAfterRetry.principalDone).toEqual(true);
    expect(tdAfterRetry.immediateClaimed).toEqual(true);
}

// 15. W3 P0-1/W3-2 delta rollback on locked slice claim bounce (preserves already-claimed principal & immediate)
get fun `test w3 partial locked slice bounce rolls back only locked delta`() {
    val env = setup();
    expect(openRound(env, 0, P0 * 2)).toHaveSuccessfulTx<OpenRound>({ to: env.rc });
    val alice = user(env, "w3-delta-alice", 2000 * A9);
    stake(env, alice, 1, 2000 * A9);
    expect(settleRound(env, 1, 20)).toHaveSuccessfulTx<SettleRound>({ to: env.rc });

    // Claim principal (2,000) + immediate (6,000) normally -> succeeds
    expect(claim(env, alice, 1)).toHaveSuccessfulTx<TicketClaimReq>({ to: env.rc });
    expect(balanceOf(env, alice)).toEqual(8000 * A9);

    // Round 2 wins -> unlocks 1st locked slice (6,000 A9) of Round 1
    expect(openRound(env, 232000, 464000)).toHaveSuccessfulTx<OpenRound>({ to: env.rc });
    expect(settleRound(env, 2, 20)).toHaveSuccessfulTx<SettleRound>({ to: env.rc });

    // Drain rcWallet to 0 so claiming the 6,000 A9 locked slice bounces natively!
    val origRcW = testing.getShardAccount(env.rcWallet)!;
    var drainedRcW = origRcW.account.load();
    if (drainedRcW is TlbAccountInfo) {
        var st = drainedRcW.storage;
        if (st.state is TlbAccountStateActive) {
            var init = st.state.stateInit;
            var wData = WalletStorage.fromCell(init.data!);
            wData.jettonBalance = 0;
            init.data = wData.toCell();
            st.state = TlbAccountStateActive { stateInit: init };
        }
        drainedRcW.storage = st;
    }
    testing.setShardAccount(env.rcWallet, {
        account: drainedRcW.toCell(),
        lastTransHash: origRcW.lastTransHash,
        lastTransLt: origRcW.lastTransLt,
    });

    var rcTonBefore: coins = 0;
    val accBefore = testing.getShardAccount(env.rc)!.account.load();
    if (accBefore is TlbAccountInfo) { rcTonBefore = accBefore.storage.balance.grams; }
    expect(rcTonBefore >= ton("0.5")).toEqual(true);
    claim(env, alice, 1);
    // Principal & immediate MUST remain true (no double-claim), while lockedClaimedRaw rolls back to 0!
    val td = ticketData(env, alice, 1);
    expect(td.pending).toEqual(false);
    expect(td.principalDone).toEqual(true);
    expect(td.immediateClaimed).toEqual(true);
    expect(td.lockedClaimedRaw).toEqual(0 as uint128);
    // RC reserve TON (originally 1+ TON from deploy) MUST NOT leak to user on ownWallet bounce!
    var rcTonAfter: coins = 0;
    val accAfter = testing.getShardAccount(env.rc)!.account.load();
    if (accAfter is TlbAccountInfo) { rcTonAfter = accAfter.storage.balance.grams; }
    expect(rcTonAfter + ton("0.05") >= rcTonBefore).toEqual(true);

    // Restore rcWallet -> retry claims exact 6,000 A9 locked slice (NOT re-paying principal/immediate)
    testing.setShardAccount(env.rcWallet, origRcW);
    expect(claim(env, alice, 1)).toHaveSuccessfulTx<TicketClaimReq>({ to: env.rc });
    expect(balanceOf(env, alice)).toEqual(14000 * A9);
    expect(ticketData(env, alice, 1).lockedClaimedRaw).toEqual((6000 * A9) as uint128);
}

// 16. W3 P1-4: SettleRound never deadlocks on >=4 stale zombies AND never bypasses an active current-round stake behind an older-round zombie
get fun `test w3 settle guards active pending stake without zombie deadlock`() {
    val env = setup();
    expect(openRound(env, 0, P0 * 2)).toHaveSuccessfulTx<OpenRound>({ to: env.rc });
    val alice = user(env, "w3-settle-guard", 2000 * A9);
    stake(env, alice, 1, 2000 * A9);

    val rd1 = round(env, 1);
    val settleAt1 = (rd1.stakeCloseAt + (OBS_WINDOW as uint64)) as uint64;

    // Inject 5 stale (>300s) zombie pendingStakes for round 1 -> SettleRound MUST NOT deadlock (was broken with findFirst + 3-item GC)
    val rcAcc = testing.getShardAccount(env.rc)!;
    var acc = rcAcc.account.load();
    if (acc is TlbAccountInfo) {
        var st = acc.storage;
        if (st.state is TlbAccountStateActive) {
            var init = st.state.stateInit;
            var rcSt = Storage.fromCell(init.data!);
            var rec = rcSt.recovery.load();
            var k: uint64 = 1;
            while (k <= 5) {
                rec.pendingStakes.set(PENDING_OP_FLAG | k, PendingStake {
                    roundId: 1,
                    owner: alice,
                    refundTo: alice,
                    amountRaw: (100 * A9) as uint128,
                    weightRaw: (100 * A9) as uint128,
                    userQueryId: k,
                    createdAt: settleAt1 - 400,
                }.toCell());
                k += 1;
            }
            rec.nextOpId = 10;
            rcSt.recovery = rec.toCell();
            init.data = rcSt.toCell();
            st.state = TlbAccountStateActive { stateInit: init };
        }
        acc.storage = st;
    }
    testing.setShardAccount(env.rc, { account: acc.toCell(), lastTransHash: rcAcc.lastTransHash, lastTransLt: rcAcc.lastTransLt });

    // Round 1 settles cleanly despite 5 stale zombies
    expect(settleRound(env, 1, 20)).toHaveSuccessfulTx<SettleRound>({ to: env.rc });

    // Open Round 2 and prepare settlement time
    expect(openRound(env, 232000, 464000)).toHaveSuccessfulTx<OpenRound>({ to: env.rc });
    val rd2 = round(env, 2);
    val r2Now = (rd2.stakeCloseAt + (OBS_WINDOW as uint64)) as uint64;
    testing.setNow(r2Now as uint32);

    // Inject an older-round (round 1) zombie at lower key AND an active (<300s) round-2 pendingStake at highest key
    val rcAcc2 = testing.getShardAccount(env.rc)!;
    var acc2 = rcAcc2.account.load();
    if (acc2 is TlbAccountInfo) {
        var st2 = acc2.storage;
        if (st2.state is TlbAccountStateActive) {
            var init2 = st2.state.stateInit;
            var rcSt2 = Storage.fromCell(init2.data!);
            var rec2 = rcSt2.recovery.load();
            rec2.pendingStakes.set(PENDING_OP_FLAG | 20, PendingStake {
                roundId: 1,
                owner: alice,
                refundTo: alice,
                amountRaw: (100 * A9) as uint128,
                weightRaw: (100 * A9) as uint128,
                userQueryId: 20,
                createdAt: r2Now - 50,
            }.toCell());
            rec2.pendingStakes.set(PENDING_OP_FLAG | 21, PendingStake {
                roundId: 2,
                owner: alice,
                refundTo: alice,
                amountRaw: (200 * A9) as uint128,
                weightRaw: (200 * A9) as uint128,
                userQueryId: 21,
                createdAt: r2Now - 10,
            }.toCell());
            rec2.nextOpId = 22;
            rcSt2.recovery = rec2.toCell();
            init2.data = rcSt2.toCell();
            st2.state = TlbAccountStateActive { stateInit: init2 };
        }
        acc2.storage = st2;
    }
    testing.setShardAccount(env.rc, { account: acc2.toCell(), lastTransHash: rcAcc2.lastTransHash, lastTransLt: rcAcc2.lastTransLt });

    // Must REJECT SettleRound with TooEarly (cannot be bypassed by older-round entry at lower key)
    val earlyRes = net.send(env.keeper, createMessage({
        bounce: true,
        value: ton("0.3"),
        dest: env.rc,
        body: SettleRound {
            queryId: 902,
            roundId: 2,
            qualifiedCandles: 20,
            candleHash: 0xabc2 as uint256,
        },
    }));
    expect(earlyRes).toHaveFailedTx<SettleRound>({ to: env.rc, exitCode: Errors.TooEarly });

    // Once active pendingStake ages past 300s TTL, SettleRound succeeds cleanly
    testing.setNow((r2Now + 310) as uint32);
    expect(net.send(env.keeper, createMessage({
        bounce: true,
        value: ton("0.3"),
        dest: env.rc,
        body: SettleRound {
            queryId: 903,
            roundId: 2,
            qualifiedCandles: 20,
            candleHash: 0xabc2 as uint256,
        },
    }))).toHaveSuccessfulTx<SettleRound>({ to: env.rc });
}

// 17. W3 P1-2 & P1-3: TicketClaimRollback preserves concurrent pending lock and commutes with additive TicketConfirm
get fun `test w3 rollback commutes with concurrent claim and preserves pending lock`() {
    val env = setup();
    expect(openRound(env, 0, P0 * 2)).toHaveSuccessfulTx<OpenRound>({ to: env.rc });
    val alice = user(env, "w3-commute-alice", 2000 * A9);
    stake(env, alice, 1, 2000 * A9);
    expect(settleRound(env, 1, 20)).toHaveSuccessfulTx<SettleRound>({ to: env.rc });
    expect(claim(env, alice, 1)).toHaveSuccessfulTx<TicketClaimReq>({ to: env.rc });

    val ticketAddr = ticketOf(env, alice, 1);
    // Simulate Claim #1 already added 3,000 A9 locked, and Claim #2 is now in-flight (pending == true)
    val tAcc = testing.getShardAccount(ticketAddr)!;
    var ta = tAcc.account.load();
    if (ta is TlbAccountInfo) {
        var ts = ta.storage;
        if (ts.state is TlbAccountStateActive) {
            var init = ts.state.stateInit;
            var td0 = TicketStorage.fromCell(init.data!);
            td0.lockedClaimedRaw = (3000 * A9) as uint128;
            td0.pending = true;
            init.data = td0.toCell();
            ts.state = TlbAccountStateActive { stateInit: init };
        }
        ta.storage = ts;
    }
    testing.setShardAccount(ticketAddr, { account: ta.toCell(), lastTransHash: tAcc.lastTransHash, lastTransLt: tAcc.lastTransLt });

    // Delayed TicketClaimRollback #1 arrives while Claim #2 is in-flight -> MUST NOT clear pending!
    val rbRes = net.send(env.rc, createMessage({
        bounce: false,
        value: ton("0.015"),
        dest: ticketAddr,
        body: TicketClaimRollback {
            queryId: 1,
            revertPrincipal: false,
            revertImm: false,
            revertLockedRaw: (3000 * A9) as uint128,
        },
    }));
    expect(rbRes).toHaveSuccessfulTx<TicketClaimRollback>({ to: ticketAddr });
    val tdMid = ticketData(env, alice, 1);
    expect(tdMid.pending).toEqual(true);
    expect(tdMid.lockedClaimedRaw).toEqual(0 as uint128);

    // Then additive TicketConfirm #2 (+4,000 A9 locked) arrives -> clears pending and preserves exact +4,000 A9 (no clobber!)
    val cfRes = net.send(env.rc, createMessage({
        bounce: false,
        value: ton("0.025"),
        dest: ticketAddr,
        body: TicketConfirm {
            queryId: 2,
            addPrincipal: false,
            addImm: false,
            addLockedRaw: (4000 * A9) as uint128,
        },
    }));
    expect(cfRes).toHaveSuccessfulTx<TicketConfirm>({ to: ticketAddr });
    val tdFinal = ticketData(env, alice, 1);
    expect(tdFinal.pending).toEqual(false);
    expect(tdFinal.principalDone).toEqual(true);
    expect(tdFinal.immediateClaimed).toEqual(true);
    expect(tdFinal.lockedClaimedRaw).toEqual((4000 * A9) as uint128);
}
