// A9 v17 任务 C 专项测试：外部 W5 运维签名状态机、规范化 BoC 真链绑定确认、存储层严格版本/状态机控制与真实双进程竞争。
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeV5R1Wallet } from '../../worker/tests/helpers/test-env.mjs';
import { cellFromBits, parseBoc, serializeBoc } from '../../worker/src/ton-cell.mjs';
import {
  W5_STATES,
  prepareExternalW5Package,
  verifyPackageBeforeSign,
  recordExternalSignCallback,
  confirmPackageOnChain,
  createTonCenterW5ChainVerifier,
  ExternalW5SessionStore,
  buildMainnetRoleConfirmationTable,
} from './lib/external-w5-signer.mjs';
import { LOCKED_BUNDLE_SHA256 } from './lib/deploy-readiness.mjs';

const TARGET_RC_MAINNET = 'EQBlX8SWerEBsIgILp3uMURwth4t8HSi_A1nC_glHv8zKnm2';
const SAMPLE_PAYLOAD_BOC = 'te6cckEBAQEABgAACNNyFYz3BlvJ';
const SIGNER_LIB_URL = new URL('./lib/external-w5-signer.mjs', import.meta.url).href;

function makeValidChainEvidence(pkg, {
  walletTxHash = '0x' + '12'.repeat(32),
  targetTxHash = '0x' + '34'.repeat(32),
  msgHash = 'msg_hash_exact_match_001',
  blockSeqno = 1001,
} = {}) {
  return {
    chainId: pkg.chainId,
    walletSeqnoAfter: pkg.seqno + 1,
    blockSeqno,
    walletTx: {
      hash: walletTxHash,
      lt: '500001',
      now: pkg.createdAt + 15,
      account: pkg.signerRaw,
      signedSeqno: pkg.seqno,
      signedValidUntil: pkg.validUntil,
      aborted: false,
      computeExitCode: 0,
      actionSuccess: true,
      outMsgs: [
        {
          msgHash,
          destination: pkg.targetContractRaw,
          valueNano: pkg.amountNano,
          bodyBoc: pkg.payloadBoc,
        },
      ],
    },
    targetTx: {
      hash: targetTxHash,
      lt: '500002',
      account: pkg.targetContractRaw,
      inMsgHash: msgHash,
      inMsgSource: pkg.signerRaw,
      inMsgValueNano: pkg.amountNano,
      aborted: false,
      bounced: false,
      computeExitCode: 0,
      actionSuccess: true,
      inMsgBodyBoc: pkg.payloadBoc,
    },
  };
}

test('C-01 准备→签名前二次核验→外部提交→真链独立确认全闭环（默认 dry-run）', async () => {
  const w5Main = await makeV5R1Wallet({ network: '-239', subwallet: 0, isSignatureAllowed: true });
  const nowSec = 1795800000;

  const prepared = await prepareExternalW5Package({
    network: 'mainnet', chainId: '-239', action: 'open-round', role: 'roundOpener',
    signerAddress: w5Main.address, walletStateInit: w5Main.stateInit, seqno: 7,
    validUntil: nowSec + 300, targetContract: TARGET_RC_MAINNET, amountNano: '100000000', payloadBoc: SAMPLE_PAYLOAD_BOC, nowSec,
  });
  assert.equal(prepared.state, W5_STATES.PREPARED);
  assert.equal(prepared.stateVersion, 1);
  assert.match(prepared.payloadCellHash, /^0x[0-9a-f]{64}$/);
  assert.equal(prepared.dryRun, true);

  const awaiting = await verifyPackageBeforeSign(prepared, {
    expectedNetwork: 'mainnet', expectedChainId: '-239',
    expectedSignerAddress: w5Main.address, expectedTargetContract: TARGET_RC_MAINNET,
    currentChainSeqno: 7, nowSec: nowSec + 10,
  });
  assert.equal(awaiting.state, W5_STATES.AWAITING_EXTERNAL_SIGNATURE);

  const submitted = recordExternalSignCallback(awaiting, {
    packageId: awaiting.packageId, chainId: '-239', signerAddress: w5Main.address,
    seqno: 7, payloadSha256: awaiting.payloadSha256, outcome: 'submitted', txHash: '0x' + '12'.repeat(32),
  }, nowSec + 20);
  assert.equal(submitted.state, W5_STATES.SIGNED_SUBMITTED);

  await assert.rejects(() => confirmPackageOnChain({ ...submitted, createdAt: nowSec - 60 },
    () => assert.fail('unexpected RPC')), { code: 'PACKAGE_TAMPERED' });
  await assert.rejects(() => verifyPackageBeforeSign({ ...prepared, packageId: 'changed' },
    { currentChainSeqno: 7, nowSec }), { code: 'PACKAGE_TAMPERED' });
  const confirmed = await confirmPackageOnChain(submitted, async (pkg) => makeValidChainEvidence(pkg), nowSec + 30);
  assert.equal(confirmed.state, W5_STATES.CONFIRMED);
  assert.equal(confirmed.confirmation.seqnoAfter, 8);
  assert.equal(confirmed.confirmation.targetTxHash, '0x' + '34'.repeat(32));
  assert.equal(confirmed.confirmation.msgHash, 'msg_hash_exact_match_001');

  await assert.rejects(() => verifyPackageBeforeSign(confirmed, { currentChainSeqno: 8, nowSec: nowSec + 40 }), (err) => err?.code === 'ALREADY_CONFIRMED');
  assert.throws(() => recordExternalSignCallback(confirmed, { packageId: confirmed.packageId }, nowSec + 40), (err) => err?.code === 'ALREADY_CONFIRMED');
  await assert.rejects(() => confirmPackageOnChain(confirmed, async (pkg) => makeValidChainEvidence(pkg), nowSec + 40), (err) => err?.code === 'ALREADY_CONFIRMED');
});

test('C-02 错误链、错误钱包、签名禁用 StateInit、过期包、过期 seqno 与 payload 篡改一律拒绝', async () => {
  const w5Main = await makeV5R1Wallet({ network: '-239', subwallet: 0, isSignatureAllowed: true });
  const w5Other = await makeV5R1Wallet({ network: '-239', subwallet: 1, isSignatureAllowed: true });
  const w5Test = await makeV5R1Wallet({ network: '-3', subwallet: 0, isSignatureAllowed: true });
  const w5NoSig = await makeV5R1Wallet({ network: '-239', subwallet: 2, isSignatureAllowed: false });
  const nowSec = 1795800000;

  await assert.rejects(() => prepareExternalW5Package({
    network: 'mainnet', chainId: '-3', action: 'settle-round', role: 'keeper',
    signerAddress: w5Main.address, walletStateInit: w5Main.stateInit, seqno: 1,
    validUntil: nowSec + 300, targetContract: TARGET_RC_MAINNET, amountNano: '400000000', payloadBoc: SAMPLE_PAYLOAD_BOC, nowSec,
  }), (err) => err?.code === 'WRONG_CHAIN');

  await assert.rejects(() => prepareExternalW5Package({
    network: 'mainnet', chainId: '-239', action: 'settle-round', role: 'keeper',
    signerAddress: w5Test.address, walletStateInit: w5Test.stateInit, seqno: 1,
    validUntil: nowSec + 300, targetContract: TARGET_RC_MAINNET, amountNano: '400000000', payloadBoc: SAMPLE_PAYLOAD_BOC, nowSec,
  }), (err) => err?.code === 'WRONG_CHAIN');

  await assert.rejects(() => prepareExternalW5Package({
    network: 'mainnet', chainId: '-239', action: 'settle-round', role: 'keeper',
    signerAddress: w5Main.address, walletStateInit: w5Other.stateInit, seqno: 1,
    validUntil: nowSec + 300, targetContract: TARGET_RC_MAINNET, amountNano: '400000000', payloadBoc: SAMPLE_PAYLOAD_BOC, nowSec,
  }), (err) => err?.code === 'STATE_INIT_ADDRESS_MISMATCH');

  await assert.rejects(() => prepareExternalW5Package({
    network: 'mainnet', chainId: '-239', action: 'settle-round', role: 'keeper',
    signerAddress: w5NoSig.address, walletStateInit: w5NoSig.stateInit, seqno: 1,
    validUntil: nowSec + 300, targetContract: TARGET_RC_MAINNET, amountNano: '400000000', payloadBoc: SAMPLE_PAYLOAD_BOC, nowSec,
  }), (err) => err?.code === 'SIGNATURE_DISABLED');

  const pkg = await prepareExternalW5Package({
    network: 'mainnet', chainId: '-239', action: 'settle-round', role: 'keeper',
    signerAddress: w5Main.address, walletStateInit: w5Main.stateInit, seqno: 5,
    validUntil: nowSec + 100, targetContract: TARGET_RC_MAINNET, amountNano: '400000000', payloadBoc: SAMPLE_PAYLOAD_BOC, nowSec,
  });

  await assert.rejects(() => verifyPackageBeforeSign(pkg, { currentChainSeqno: 5, nowSec: nowSec + 100 }), (err) => err?.code === 'EXPIRED_PACKAGE');
  await assert.rejects(() => verifyPackageBeforeSign(pkg, { currentChainSeqno: 6, nowSec: nowSec + 10 }), (err) => err?.code === 'STALE_SEQNO');
  await assert.rejects(() => verifyPackageBeforeSign(pkg, { expectedSignerAddress: w5Other.address, currentChainSeqno: 5, nowSec: nowSec + 10 }), (err) => err?.code === 'WRONG_WALLET');
  await assert.rejects(() => verifyPackageBeforeSign({ ...pkg, payloadBoc: 'te6cckEBAQEABgAACNNyFYz3BlvK' }, { currentChainSeqno: 5, nowSec: nowSec + 10 }), (err) => err?.code === 'PACKAGE_TAMPERED' || err?.code === 'PAYLOAD_TAMPERED');
});

test('C-03 模糊/超时结果进入待核查状态、禁止自动重签、拒绝重复回调并支持重启持久化恢复', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'a9-w5-test-'));
  try {
    const storePath = join(dir, 'w5-sessions.json');
    const store1 = new ExternalW5SessionStore(storePath);
    const w5Main = await makeV5R1Wallet({ network: '-239', subwallet: 0, isSignatureAllowed: true });
    const nowSec = 1795800000;

    const prepared = store1.save(await prepareExternalW5Package({
      network: 'mainnet', chainId: '-239', action: 'settle-round', role: 'keeper',
      signerAddress: w5Main.address, walletStateInit: w5Main.stateInit, seqno: 10,
      validUntil: nowSec + 300, targetContract: TARGET_RC_MAINNET, amountNano: '400000000', payloadBoc: SAMPLE_PAYLOAD_BOC, nowSec,
    }));
    const awaiting = await store1.update(prepared.packageId, 1, (cur) => verifyPackageBeforeSign(cur, { currentChainSeqno: 10, nowSec: nowSec + 5 }));
    const pending = await store1.update(awaiting.packageId, 2, (cur) => recordExternalSignCallback(cur, {
      packageId: cur.packageId, chainId: '-239', signerAddress: w5Main.address,
      seqno: 10, payloadSha256: cur.payloadSha256, outcome: 'timeout',
    }, nowSec + 15));
    assert.equal(pending.state, W5_STATES.PENDING_CHAIN_VERIFICATION);
    assert.equal(pending.stateVersion, 3);

    const store2 = new ExternalW5SessionStore(storePath);
    const reloaded = store2.load(pending.packageId);
    assert.equal(reloaded.state, W5_STATES.PENDING_CHAIN_VERIFICATION);

    await assert.rejects(() => verifyPackageBeforeSign(reloaded, { currentChainSeqno: 10, nowSec: nowSec + 20 }), (err) => err?.code === 'AMBIGUOUS_REQUIRES_CHAIN_CHECK');
    assert.throws(() => recordExternalSignCallback(reloaded, {
      packageId: reloaded.packageId, chainId: '-239', signerAddress: w5Main.address,
      seqno: 10, payloadSha256: reloaded.payloadSha256, outcome: 'submitted', txHash: '0x' + 'aa'.repeat(32),
    }, nowSec + 25), (err) => err?.code === 'DUPLICATE_CALLBACK');

    const stillPending = await store2.update(reloaded.packageId, 3, (cur) => confirmPackageOnChain(cur, async () => ({ reason: 'rpc_timeout' }), nowSec + 30));
    assert.equal(stillPending.state, W5_STATES.PENDING_CHAIN_VERIFICATION);
    assert.equal(stillPending.stateVersion, 4);

    const confirmed = await store2.update(stillPending.packageId, 4, (cur) => confirmPackageOnChain(
      cur,
      async (pkg) => makeValidChainEvidence(pkg, { walletTxHash: '0x' + 'bb'.repeat(32), targetTxHash: '0x' + 'cc'.repeat(32), blockSeqno: 2002 }),
      nowSec + 45,
    ));
    assert.equal(confirmed.state, W5_STATES.CONFIRMED);
    assert.equal(confirmed.stateVersion, 5);
    assert.equal(new ExternalW5SessionStore(storePath).load(confirmed.packageId).state, W5_STATES.CONFIRMED);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('C-04 从锁定主网部署包提取公开角色确认表：保留 keeper/roundOpener 合设待业主签认', () => {
  const table = buildMainnetRoleConfirmationTable();
  assert.equal(table.bundleSha256, LOCKED_BUNDLE_SHA256);
  assert.equal(table.network, 'mainnet');
  assert.equal(table.chainId, '-239');
  assert.equal(table.roleCount, 7);
  assert.equal(table.uniqueAddressCount, 6);
  assert.equal(table.keeperRoundOpenerShared, true);
  assert.equal(table.ownerSignedOff, false);
  assert.equal(table.pendingOwnerDecisions.length, 1);
});

test('C-05 复现修复：禁止仅凭 confirmed:true 或回调哈希推进成功，并验证 TonCenter v3 规范化 BoC 确认器契约', async () => {
  const w5Main = await makeV5R1Wallet({ network: '-239', subwallet: 0, isSignatureAllowed: true });
  const nowSec = 1795800000;
  const prepared = await prepareExternalW5Package({
    network: 'mainnet', chainId: '-239', action: 'open-round', role: 'roundOpener',
    signerAddress: w5Main.address, walletStateInit: w5Main.stateInit, seqno: 7,
    validUntil: nowSec + 300, targetContract: TARGET_RC_MAINNET, amountNano: '100000000', payloadBoc: SAMPLE_PAYLOAD_BOC, nowSec,
  });
  const awaiting = await verifyPackageBeforeSign(prepared, { currentChainSeqno: 7, nowSec: nowSec + 5 });
  const submitted = recordExternalSignCallback(awaiting, {
    packageId: awaiting.packageId, chainId: '-239', signerAddress: w5Main.address,
    seqno: 7, payloadSha256: awaiting.payloadSha256, outcome: 'submitted', txHash: '0x' + '99'.repeat(32),
  }, nowSec + 10);

  const rejectedFake = await confirmPackageOnChain(submitted, async () => ({ confirmed: true, txHash: '0x' + '99'.repeat(32) }), nowSec + 20);
  assert.equal(rejectedFake.state, W5_STATES.PENDING_CHAIN_VERIFICATION);

  const bouncedEv = makeValidChainEvidence(rejectedFake);
  bouncedEv.targetTx.bounced = true;
  const rejectedBounce = await confirmPackageOnChain(rejectedFake, async () => bouncedEv, nowSec + 25);
  assert.equal(rejectedBounce.state, W5_STATES.PENDING_CHAIN_VERIFICATION);

  // 构造真实的 W5 外部签名请求头 BoC（op=0x7369676e, walletId=0, validUntil=nowSec+300, seqno=7）
  const w5ExtBits =
    (0x7369676en).toString(2).padStart(32, '0')
    + (0n).toString(2).padStart(32, '0')
    + BigInt(nowSec + 300).toString(2).padStart(32, '0')
    + (7n).toString(2).padStart(32, '0');
  const w5ExtBoc = await serializeBoc(cellFromBits(w5ExtBits));
  const w5ExtBocStr = typeof w5ExtBoc === 'string' ? w5ExtBoc : Buffer.from(w5ExtBoc).toString('base64');

  // 故意使用无 CRC 的等价规范化 BoC（base64 文本与 SAMPLE_PAYLOAD_BOC 不同，但根 Cell 哈希完全一致！）
  const altPayloadBoc = await serializeBoc(parseBoc(SAMPLE_PAYLOAD_BOC)[0]);
  const altPayloadBocStr = typeof altPayloadBoc === 'string' ? altPayloadBoc : Buffer.from(altPayloadBoc).toString('base64');
  assert.notEqual(altPayloadBocStr, SAMPLE_PAYLOAD_BOC);

  const verifier = createTonCenterW5ChainVerifier({
    network: 'mainnet',
    fetchJson: async (path) => {
      if (path === '/runGetMethod') {
        return { exit_code: 0, stack: [{ type: 'num', value: '0x8' }] };
      }
      if (path.includes(encodeURIComponent(w5Main.address))) {
        return {
          transactions: [{
            hash: 'wallet_v3_hash_ok',
            lt: '9001',
            now: nowSec + 18,
            account: prepared.signerRaw,
            mc_block_seqno: 42000,
            description: { aborted: false, compute_ph: { exit_code: 0 }, action: { success: true } },
            in_msg: { message_content: { body: w5ExtBocStr } },
            out_msgs: [{ hash: 'msg_link_v3_999', destination: prepared.targetContractRaw, value: '100000000', message_content: { body: altPayloadBocStr } }],
          }],
        };
      }
      return {
        transactions: [{
          hash: 'target_v3_hash_ok',
          lt: '9002',
          account: prepared.targetContractRaw,
          mc_block_seqno: 42001,
          description: { aborted: false, compute_ph: { exit_code: 0 }, action: { success: true } },
          in_msg: { hash: 'msg_link_v3_999', source: prepared.signerRaw, value: '100000000', message_content: { body: SAMPLE_PAYLOAD_BOC } },
        }],
      };
    },
  });

  const confirmed = await confirmPackageOnChain(rejectedBounce, verifier, nowSec + 30);
  assert.equal(confirmed.state, W5_STATES.CONFIRMED);
  assert.equal(confirmed.confirmation.walletTxHash, 'wallet_v3_hash_ok');
  assert.equal(confirmed.confirmation.targetTxHash, 'target_v3_hash_ok');
  assert.equal(confirmed.confirmation.msgHash, 'msg_link_v3_999');
});

test('C-06 真实双进程竞争互斥、崩溃残留恢复与乐观版本保护', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'a9-w5-proc-'));
  try {
    const storePath = join(dir, 'w5-sessions.json');
    const store = new ExternalW5SessionStore(storePath);
    const w5Main = await makeV5R1Wallet({ network: '-239', subwallet: 0, isSignatureAllowed: true });
    const nowSec = 1795800000;

    const prepared = store.save(await prepareExternalW5Package({
      network: 'mainnet', chainId: '-239', action: 'open-round', role: 'roundOpener',
      signerAddress: w5Main.address, walletStateInit: w5Main.stateInit, seqno: 1,
      validUntil: nowSec + 300, targetContract: TARGET_RC_MAINNET, amountNano: '100000000', payloadBoc: SAMPLE_PAYLOAD_BOC, nowSec,
    }));

    // 模拟崩溃残留未完成 .tmp 文件：主状态文件必须完好无损
    writeFileSync(`${storePath}.tmp.99999.deadbeef`, '{"corrupt_partial":', 'utf8');
    assert.equal(store.load(prepared.packageId).stateVersion, 1);

    // 真实双进程并发竞争：同时启动两个独立 Node 子进程竞争将 version=1 推进到 AWAITING_EXTERNAL_SIGNATURE
    const workerCode = `
      import { ExternalW5SessionStore, verifyPackageBeforeSign } from ${JSON.stringify(SIGNER_LIB_URL)};
      const store = new ExternalW5SessionStore(process.env.STORE_PATH);
      try {
        await store.update(process.env.PKG_ID, 1, async (cur) => {
          await new Promise((r) => setTimeout(r, 40));
          return verifyPackageBeforeSign(cur, { currentChainSeqno: 1, nowSec: Number(process.env.NOW_SEC) });
        });
        process.stdout.write('WIN');
      } catch (e) {
        process.stdout.write('ERR:' + (e.code || e.message));
      }
    `;
    const runChild = () => new Promise((resolveDone) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', workerCode], {
        env: { ...process.env, STORE_PATH: storePath, PKG_ID: prepared.packageId, NOW_SEC: String(nowSec + 5) },
      });
      let out = '';
      child.stdout.on('data', (d) => { out += String(d); });
      child.on('close', () => resolveDone(out));
    });

    const [res1, res2] = await Promise.all([runChild(), runChild()]);
    const wins = [res1, res2].filter((r) => r === 'WIN').length;
    const rejected = [res1, res2].filter((r) => r.startsWith('ERR:STORE_LOCK_BUSY') || r.startsWith('ERR:STATE_VERSION_CONFLICT')).length;
    assert.equal(wins, 1, `expected exactly 1 winner, got [${res1}, ${res2}]`);
    assert.equal(rejected, 1, `expected exactly 1 conflict/lock reject, got [${res1}, ${res2}]`);

    const finalState = store.load(prepared.packageId);
    assert.equal(finalState.state, W5_STATES.AWAITING_EXTERNAL_SIGNATURE);
    assert.equal(finalState.stateVersion, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('C-07 反例复现：W5 确认必须绑定 seqno/有效期/消息哈希关联/精确金额，拒绝历史旧交易、不相关目标交易与超额金额', async () => {
  const w5Main = await makeV5R1Wallet({ network: '-239', subwallet: 0, isSignatureAllowed: true });
  const nowSec = 1795800000;
  const prepared = await prepareExternalW5Package({
    network: 'mainnet', chainId: '-239', action: 'open-round', role: 'roundOpener',
    signerAddress: w5Main.address, walletStateInit: w5Main.stateInit, seqno: 7,
    validUntil: nowSec + 300, targetContract: TARGET_RC_MAINNET, amountNano: '100000000', payloadBoc: SAMPLE_PAYLOAD_BOC, nowSec,
  });
  const awaiting = await verifyPackageBeforeSign(prepared, { currentChainSeqno: 7, nowSec: nowSec + 5 });
  const submitted = recordExternalSignCallback(awaiting, {
    packageId: awaiting.packageId, chainId: '-239', signerAddress: w5Main.address,
    seqno: 7, payloadSha256: awaiting.payloadSha256, outcome: 'submitted', txHash: '0x' + '11'.repeat(32),
  }, nowSec + 10);

  // 反例 1：历史相同 payload 的旧交易（时间早于包创建时间）拒绝
  const staleHistoryEv = makeValidChainEvidence(submitted);
  staleHistoryEv.walletTx.now = nowSec - 600;
  const r1 = await confirmPackageOnChain(submitted, async () => staleHistoryEv, nowSec + 20);
  assert.equal(r1.state, W5_STATES.PENDING_CHAIN_VERIFICATION);

  // 反例 2：钱包出站消息哈希与目标入站消息哈希不一致（不相关目标交易）拒绝
  const unrelatedTargetEv = makeValidChainEvidence(r1);
  unrelatedTargetEv.walletTx.outMsgs[0].msgHash = 'msg_hash_A';
  unrelatedTargetEv.targetTx.inMsgHash = 'msg_hash_B';
  const r2 = await confirmPackageOnChain(r1, async () => unrelatedTargetEv, nowSec + 25);
  assert.equal(r2.state, W5_STATES.PENDING_CHAIN_VERIFICATION);

  // 反例 3：金额不精确（多付了 1 nano）拒绝
  const wrongAmountEv = makeValidChainEvidence(r2);
  wrongAmountEv.walletTx.outMsgs[0].valueNano = '100000001';
  const r3 = await confirmPackageOnChain(r2, async () => wrongAmountEv, nowSec + 30);
  assert.equal(r3.state, W5_STATES.PENDING_CHAIN_VERIFICATION);

  // 反例 4：其他交易推进 seqno（signedSeqno !== pkg.seqno）拒绝
  const otherSeqnoEv = makeValidChainEvidence(r3);
  otherSeqnoEv.walletTx.signedSeqno = 8;
  const r4 = await confirmPackageOnChain(r3, async () => otherSeqnoEv, nowSec + 35);
  assert.equal(r4.state, W5_STATES.PENDING_CHAIN_VERIFICATION);
});

test('C-08 反例复现：ExternalW5SessionStore 强制版本由存储层控制、同版本不同内容拒绝、CONFIRMED 不得回退', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'a9-w5-state-'));
  try {
    const storePath = join(dir, 'w5-sessions.json');
    const store = new ExternalW5SessionStore(storePath);
    const w5Main = await makeV5R1Wallet({ network: '-239', subwallet: 0, isSignatureAllowed: true });
    const nowSec = 1795800000;
    const prepared = store.save(await prepareExternalW5Package({
      network: 'mainnet', chainId: '-239', action: 'open-round', role: 'roundOpener',
      signerAddress: w5Main.address, walletStateInit: w5Main.stateInit, seqno: 2,
      validUntil: nowSec + 300, targetContract: TARGET_RC_MAINNET, amountNano: '100000000', payloadBoc: SAMPLE_PAYLOAD_BOC, nowSec,
    }));

    // 反例 1：同版本不同内容必须被拒绝
    assert.throws(
      () => store.save({ ...prepared, state: W5_STATES.AWAITING_EXTERNAL_SIGNATURE }),
      (err) => err?.code === 'STATE_VERSION_CONFLICT',
    );

    // 正常推进到 CONFIRMED，且存储层强制版本单调 +1（忽略调用方伪造的 stateVersion=99）
    const awaiting = store.save(await verifyPackageBeforeSign(prepared, { currentChainSeqno: 2, nowSec: nowSec + 5 }));
    assert.equal(awaiting.stateVersion, 2);
    const submitted = store.save(recordExternalSignCallback(awaiting, {
      packageId: awaiting.packageId, chainId: '-239', signerAddress: w5Main.address,
      seqno: 2, payloadSha256: awaiting.payloadSha256, outcome: 'submitted', txHash: '0x' + '22'.repeat(32),
    }, nowSec + 10));
    assert.equal(submitted.stateVersion, 3);
    const confirmed = store.save({ ...submitted, state: W5_STATES.CONFIRMED, stateVersion: 99 });
    assert.equal(confirmed.stateVersion, 4); // 存储层掌控版本递增（严格 +1）

    // 反例 2：CONFIRMED 终态永不回退或修改
    assert.throws(
      () => store.save({ ...prepared, stateVersion: 100 }),
      (err) => err?.code === 'INVALID_STATE_TRANSITION',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
