// A9 Protocol v15 — Standard TEP-74 JettonMaster + JettonWallet unit tests
import "@acton/emulation/network"
import "@acton/emulation/testing"
import "@acton/testing/expect"
import "@acton/types/message"
import "@contracts/jetton/storage"
import "@contracts/jetton/errors"
import "helpers"

get fun `test jetton mint once 10B then admin permanently dropped`() {
    val env = setup();
    val data = net.runGetMethod<JettonDataReply>(env.master, "get_jetton_data");
    expect(data.totalSupply).toEqual(SUPPLY as int);
    expect(data.mintable).toEqual(false);
    expect(data.adminAddress == null).toEqual(true);

    // Second mint attempt must fail with MintClosed
    expect(net.send(env.treasury, createMessage({
        bounce: true,
        value: ton("1"),
        dest: env.master,
        body: MintOnceMsg {
            queryId: 2,
            recipient: env.treasury,
            tonAmount: ton("0.3"),
            jettonAmount: SUPPLY,
            totalTonAmount: ton("0.5"),
            forwardPayload: emptyPayload(),
        },
    }))).toHaveFailedTx<MintOnceMsg>({ to: env.master, exitCode: JettonErrors.MintClosed });
}

get fun `test jetton standard transfer and burn reduce total supply`() {
    val env = setup();
    val alice = user(env, "jt-alice", 5000 * A9);
    val bob = testing.treasury("jt-bob").address;

    transfer(alice, walletOf(env.master, alice), bob, 2000 * A9, 0, emptyPayload(), ton("0.15"));
    expect(balanceOf(env, alice)).toEqual(3000 * A9);
    expect(balanceOf(env, bob)).toEqual(2000 * A9);

    // Bob burns 500 A9
    val supBefore = totalSupply(env);
    expect(net.send(bob, createMessage({
        bounce: true,
        value: ton("0.1"),
        dest: walletOf(env.master, bob),
        body: AskToBurnMsg { queryId: 9, jettonAmount: 500 * A9, sendExcessesTo: bob, customPayload: null },
    }))).toHaveSuccessfulTx<AskToBurnMsg>({ to: walletOf(env.master, bob) });

    expect(balanceOf(env, bob)).toEqual(1500 * A9);
    expect(totalSupply(env)).toEqual(supBefore - 500 * A9);
}
