// A9 协议 v16 — 标准 TEP-74 JettonMaster + JettonWallet 单元测试
import "@acton/emulation/network"
import "@acton/emulation/testing"
import "@acton/testing/expect"
import "@acton/types/message"
import "@contracts/jetton/storage"
import "helpers"

get fun `test jetton mint once preserves admin until DropMinterAdmin and blocks double mint`() {
    val treasury = testing.treasury("jt-p0-treasury");
    val master = deployMaster(treasury.address);

    // 铸币 10B 后 totalSupply == 10B 且 mintable 立即为 false，但 admin 保留以便核验收讫后再弃权
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

    val mid = net.runGetMethod<JettonDataReply>(master, "get_jetton_data");
    expect(mid.totalSupply).toEqual(SUPPLY as int);
    expect(mid.mintable).toEqual(false);
    expect(mid.adminAddress != null).toEqual(true);

    // 即使在 DropMinterAdmin 之前，二次 MintOnce 也必须以 MintClosed 拒绝
    expect(net.send(treasury.address, createMessage({
        bounce: true,
        value: ton("1"),
        dest: master,
        body: MintOnceMsg {
            queryId: 2,
            recipient: treasury.address,
            tonAmount: ton("0.3"),
            jettonAmount: SUPPLY,
            totalTonAmount: ton("0.5"),
            forwardPayload: emptyPayload(),
        },
    }))).toHaveFailedTx<MintOnceMsg>({ to: master, exitCode: JettonErrors.MintClosed });

    // 执行 DropMinterAdmin 后永久弃权
    expect(net.send(treasury.address, createMessage({
        bounce: true,
        value: ton("0.05"),
        dest: master,
        body: DropMinterAdmin { queryId: 3 },
    }))).toHaveSuccessfulTx<DropMinterAdmin>({ to: master });

    val done = net.runGetMethod<JettonDataReply>(master, "get_jetton_data");
    expect(done.adminAddress == null).toEqual(true);
    expect(done.mintable).toEqual(false);
}

get fun `test jetton mint once 10B then admin permanently dropped`() {
    val env = setup();
    val data = net.runGetMethod<JettonDataReply>(env.master, "get_jetton_data");
    expect(data.totalSupply).toEqual(SUPPLY as int);
    expect(data.mintable).toEqual(false);
    expect(data.adminAddress == null).toEqual(true);

    // 二次铸币必须以 MintClosed 拒绝
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
