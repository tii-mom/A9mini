#!/usr/bin/env node
// A9 Protocol v15 — Offline unit tests for frontend TON Connect v15 tx builders.
import assert from 'node:assert/strict';
import {
  encodeSingleCellBoc,
  encodeTextCommentBoc,
  encodeTicketClaimBoc,
  parseTonAddress,
  buildV15StakeTx,
  buildV15ClaimTx,
  buildV15PromoFeeTx,
  buildV15PresaleTx,
  V15_GAS,
} from './v15-tx.js';

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  PASS  ${name}`);
}

console.log('Running A9 v15 frontend tx-builder tests...');

test('encodeTicketClaimBoc encodes valid BOC magic, op 0x52540303, and 64-bit queryId', () => {
  const b64 = encodeTicketClaimBoc(42n);
  const raw = Buffer.from(b64, 'base64');
  assert.equal(raw.subarray(0, 4).toString('hex'), 'b5ee9c72');
  assert.equal(raw.readUInt32BE(13), 0x52540303);
  assert.equal(raw.readBigUInt64BE(17), 42n);
});

test('encodeTextCommentBoc encodes 0x00000000 prefix + UTF-8 claim memo', () => {
  const memo = 'claim:a1b2c3d4e5f6';
  const b64 = encodeTextCommentBoc(memo);
  const raw = Buffer.from(b64, 'base64');
  assert.equal(raw.subarray(0, 4).toString('hex'), 'b5ee9c72');
  assert.equal(raw.readUInt32BE(13), 0x00000000);
  assert.equal(raw.subarray(17).toString('utf8'), memo);
});

test('parseTonAddress decodes both friendly base64url and raw 0:hex TON addresses and rejects bad CRC16', () => {
  const friendly = parseTonAddress('kQDo-Kai2-tgKj_AErlFDfDyiA0jO2U4RvJaX45OykVMCT18');
  assert.equal(friendly.workchain, 0);
  assert.equal(friendly.hash.length, 32);

  const rawAddr = parseTonAddress(`0:${'ab'.repeat(32)}`);
  assert.equal(rawAddr.workchain, 0);
  assert.equal(rawAddr.hash[0], 0xab);

  // Tampering last character breaks CRC16-CCITT and must throw
  assert.throws(() => parseTonAddress('kQDo-Kai2-tgKj_AErlFDfDyiA0jO2U4RvJaX45OykVMCT19'), /CRC16/);
  // Invalid workchain or empty workchain prefix in raw format must throw
  assert.throws(() => parseTonAddress(`2:${'ab'.repeat(32)}`), /workchain/);
  assert.throws(() => parseTonAddress(`:${'ab'.repeat(32)}`), /invalid raw TON address/);
});

test('buildV15StakeTx builds valid 2-cell TEP-74 AskToTransfer BOC with 0x5254000F child ref', () => {
  const tx = buildV15StakeTx({
    userJettonWallet: 'kQAZFnSDKMIwiflOo8YWiNweqnxTRuwejtg7qmic4pjf1rIP',
    roundController: 'kQDo-Kai2-tgKj_AErlFDfDyiA0jO2U4RvJaX45OykVMCT18',
    userAddress: 'kQAZFnSDKMIwiflOo8YWiNweqnxTRuwejtg7qmic4pjf1rIP',
    amountA9Raw: '10000000000000', // 10,000 A9
    roundId: 1,
    queryId: 77n,
  });
  assert.equal(tx.messages.length, 1);
  assert.equal(tx.messages[0].amount, V15_GAS.STAKE_TOTAL_NANO);
  const raw = Buffer.from(tx.messages[0].payload, 'base64');
  assert.equal(raw.subarray(0, 4).toString('hex'), 'b5ee9c72');
  assert.equal(raw[6], 2); // 2 cells (root AskToTransfer + child StakeDeposit ref)
  assert.equal(raw.readUInt32BE(13), 0x0f8a7ea5); // OP_JETTON_TRANSFER
  assert.equal(raw.readBigUInt64BE(17), 77n);
});

test('v16 stake is default and encodes full 32-bit round IDs while keeping explicit v15 distinct', () => {
  const address = '0:' + 'ab'.repeat(32);
  const stake = {
    userJettonWallet: address,
    roundController: address,
    userAddress: address,
    amountA9Raw: '10000000000000',
    queryId: 77n,
  };
  const encode = (roundId, protocolVersion) => Buffer.from(
    buildV15StakeTx({ ...stake, roundId, ...(protocolVersion !== undefined ? { protocolVersion } : {}) }).messages[0].payload, 'base64',
  );
  assert.equal(encode(256).subarray(-9).toString('hex'), '525400100000010020');
  assert.equal(encode(0xffffffff).subarray(-9).toString('hex'), '52540010ffffffff20');
  assert.equal(encode(255, 'v15').subarray(-6).toString('hex'), '5254000fff20');
  assert.throws(() => encode(256, 'v15'), /1\.\.255/);
  assert.throws(() => encode(0x100000000), /1\.\.4294967295/);
  assert.throws(() => encode(1, 'v14'), /unsupported stake protocol version/);
});

test('buildV15ClaimTx and buildV15PromoFeeTx produce valid TON Connect 2.0 message payloads', () => {
  const claimTx = buildV15ClaimTx('EQ_TICKET_DEMO', 99n);
  assert.equal(claimTx.messages.length, 1);
  assert.equal(claimTx.messages[0].amount, V15_GAS.CLAIM_NANO);
  assert.ok(claimTx.messages[0].payload.length > 10);

  const promoTx = buildV15PromoFeeTx({
    payTo: 'EQ_PROMO_HOT_DEMO',
    feeRequiredNano: '60000000',
    memo: 'claim:deadbeef1234',
  });
  assert.equal(promoTx.messages[0].address, 'EQ_PROMO_HOT_DEMO');
  assert.equal(promoTx.messages[0].amount, '60000000');
  assert.throws(() => buildV15PromoFeeTx({ payTo: 'EQ_X', memo: 'bad' }));
});

test('encodeSingleCellBoc rejects payloads > 127 bytes', () => {
  assert.throws(() => encodeSingleCellBoc(new Uint8Array(128)));
});

test('buildV15PresaleTx builds valid buy:<orderId> TON Connect 2.0 payload and rejects invalid memos', () => {
  const tx = buildV15PresaleTx({
    payTo: 'EQ_PRESALE_HOT_DEMO',
    tonNano: '990000000',
    memo: 'buy:ord_chest_01',
  });
  assert.equal(tx.messages.length, 1);
  assert.equal(tx.messages[0].address, 'EQ_PRESALE_HOT_DEMO');
  assert.equal(tx.messages[0].amount, '990000000');
  const raw = Buffer.from(tx.messages[0].payload, 'base64');
  assert.equal(raw.subarray(0, 4).toString('hex'), 'b5ee9c72');
  assert.throws(() => buildV15PresaleTx({ payTo: 'EQ_X', tonNano: '990000000', memo: 'claim:123' }));
  assert.throws(() => buildV15PresaleTx({ payTo: 'EQ_X', tonNano: '0', memo: 'buy:123' }));
});

console.log(`All ${passed} v15 frontend tx-builder tests passed.`);
