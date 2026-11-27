import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { queryLiveDeployStatusOnce, parseStackAddress, loadLockedCodeHashes, parseConsoleBoc } from '../deploy-console/server.mjs';
import { cellFromBits, serializeBoc } from '../../worker/src/ton-cell.mjs';
import { parseTonAddress } from '../../a9-mini-app/js/v15-tx.js';

const bundle = JSON.parse(readFileSync(new URL('../deploy-console/bundle-mainnet-v17.0.json', import.meta.url)));
const hashes = await loadLockedCodeHashes(bundle);
const total = '10000000000000000000';
const funding = '8200000000000000000';
const key = (a) => {
  const p = parseTonAddress(a);
  return `${p.workchain}:${Buffer.from(p.hash).toString('hex')}`;
};
const num = (value) => ({ type: 'num', value: String(value) });
async function addressStack(address) {
  if (address === null) return { type: 'slice', value: await serializeBoc(cellFromBits('00')) };
  const p = parseTonAddress(address);
  const bits = '100' + (p.workchain & 255).toString(2).padStart(8, '0') + [...p.hash].map((v) => v.toString(2).padStart(8, '0')).join('');
  return { type: 'slice', value: await serializeBoc(cellFromBits(bits)) };
}
async function fixture({ stage = 0 } = {}) {
  const addresses = [bundle.roles.deployer, bundle.roles.treasury, ...['jettonMaster', 'roundController', 'treasuryJettonWallet', 'rcJettonWallet'].map((f) => bundle.contracts[f])];
  const accounts = addresses.map((address) => ({ address, status: 'uninit', balance: '10000000000' }));
  const byAddress = new Map(accounts.map((a) => [key(a.address), a]));
  const activate = (field, type) => Object.assign(byAddress.get(key(bundle.contracts[field])), { status: 'active', code_hash: hashes[type] });
  const getters = new Map();
  if (stage >= 1) {
    activate('jettonMaster', 'JettonMaster');
    // JettonMaster.tolk:151 defines mintable = (totalSupply == 0 && adminAddress != null), so post-MintOnce stage===2 has mintable = 0 (false).
    getters.set('get_jetton_data', { exit_code: 0, stack: [num(stage >= 2 ? total : 0), num(stage >= 2 ? 0 : -1), await addressStack(stage >= 3 ? null : bundle.roles.treasury)] });
  }
  if (stage >= 2) {
    activate('treasuryJettonWallet', 'JettonWallet');
    getters.set(key(bundle.contracts.treasuryJettonWallet), { exit_code: 0, stack: [num(stage >= 5 ? '1800000000000000000' : total), await addressStack(bundle.roles.treasury), await addressStack(bundle.contracts.jettonMaster)] });
  }
  if (stage >= 4) activate('roundController', 'RoundController');
  if (stage >= 5) {
    activate('rcJettonWallet', 'JettonWallet');
    getters.set(key(bundle.contracts.rcJettonWallet), { exit_code: 0, stack: [num(funding), await addressStack(bundle.contracts.roundController), await addressStack(bundle.contracts.jettonMaster)] });
  }
  const fetchJson = async (path, opts) => {
    if (path.startsWith('/accountStates')) return { accounts };
    const { address, method } = JSON.parse(opts.body);
    return getters.get(method === 'get_jetton_data' ? method : key(address));
  };
  return { accounts, getters, fetchJson, read: () => queryLiveDeployStatusOnce({ deployBundle: bundle, fetchJson }) };
}
const blocked = (r) => {
  assert.equal(r.verified, false);
  assert.equal(r.allDone, false);
  assert.ok(r.errors.length);
  for (const s of Object.values(r.steps)) assert.equal(s.unlocked, false);
};

test('Deployment console: all five stages unlock only their verified next action', async () => {
  for (let stage = 0; stage <= 5; stage++) {
    const f = await fixture({ stage }); const r = await f.read();
    assert.equal(r.verified, true, JSON.stringify(r.errors));
    assert.deepEqual(Object.entries(r.steps).filter(([, s]) => s.unlocked).map(([n]) => Number(n)), stage === 5 ? [] : [stage + 1]);
    assert.equal(r.allDone, stage === 5);
  }
  // Abnormal pseudo-state (supply === total && mintable === true) cannot pass validMinter
  const pseudo = await fixture({ stage: 2 });
  pseudo.getters.get('get_jetton_data').stack[1] = num(-1);
  const pr = await pseudo.read();
  blocked(pr);
  assert.deepEqual(pr.errors, ['UNEXPECTED_MINTER_STATE']);
});

test('Deployment console: absent account list, missing address, duplicate, invalid balance, and RPC failure fail closed', async () => {
  for (const response of [{}, null, { accounts: [] }, { ok: false, accounts: [] }]) {
    blocked(await queryLiveDeployStatusOnce({ fetchJson: async () => response }));
  }
  for (const mutate of [
    (f) => f.accounts.pop(),
    (f) => f.accounts.push({ ...f.accounts[0] }),
    (f) => { delete f.accounts[0].balance; },
    (f) => { f.accounts[0].balance = '-1'; },
    (f) => { f.accounts[0].status = 'frozen'; },
  ]) { const f = await fixture(); mutate(f); blocked(await f.read()); }
  blocked(await queryLiveDeployStatusOnce({ fetchJson: async () => { throw new Error('HTTP 403: private upstream content'); } }));
});

test('Deployment console: missing/failed getter cannot re-enable MintOnce after deployment', async () => {
  for (const bad of [undefined, { exit_code: 401, stack: [] }, { exit_code: 0 }, { exit_code: 0, stack: [] }, { exit_code: 0, stack: [num(total), num(0)] }]) {
    const f = await fixture({ stage: 2 }); f.getters.set('get_jetton_data', bad);
    blocked(await f.read());
  }
  const f = await fixture({ stage: 2 }); f.getters.set(key(bundle.contracts.treasuryJettonWallet), { exit_code: 0, stack: [] }); blocked(await f.read());
});

test('Deployment console: active code hashes must match locked artifacts, including JettonWallet', async () => {
  for (const index of [2, 3, 4, 5]) {
    const f = await fixture({ stage: 5 }); f.accounts[index].code_hash = 'aa'.repeat(32); blocked(await f.read());
  }
  const f = await fixture({ stage: 1 }); delete f.accounts[2].code_hash; blocked(await f.read());
});

test('Deployment console: exact addr_none BOC is required; short, malformed, trailing and CRC-corrupt BOCs fail', async () => {
  const none = await addressStack(null);
  assert.equal(parseStackAddress(none), null);
  assert.equal(parseStackAddress(await addressStack(bundle.roles.treasury)), key(bundle.roles.treasury));
  for (const bad of ['', 'AAAA', 'not base64', none.value + 'AAAA']) assert.throws(() => parseStackAddress({ type: 'slice', value: bad }));
  assert.throws(() => parseStackAddress({ type: 'null' }));
  const wrongBits = await serializeBoc(cellFromBits('000'));
  assert.throws(() => parseStackAddress({ type: 'slice', value: wrongBits }));
  const bytes = Buffer.from(none.value, 'base64'); bytes[4] |= 64;
  const corruptCrc = Buffer.concat([bytes, Buffer.alloc(4)]).toString('base64');
  assert.throws(() => parseConsoleBoc(corruptCrc));
  const padded = Buffer.from(none.value, 'base64'); padded[9] += 1;
  assert.throws(() => parseConsoleBoc(Buffer.concat([padded, Buffer.from([0])]).toString('base64')));
});

test('Deployment console: mint receipt and exact funding checks stop unexpected balances', async () => {
  const f = await fixture({ stage: 2 }); f.getters.get(key(bundle.contracts.treasuryJettonWallet)).stack[0] = num(0); blocked(await f.read());
  const funded = await fixture({ stage: 5 }); funded.getters.get(key(bundle.contracts.rcJettonWallet)).stack[0] = num(BigInt(funding) + 1n); blocked(await funded.read());
});

test('Deployment console: malformed getters, wrong owner, and invalid admin prevent signing', async () => {
  const f = await fixture({ stage: 1 }); f.getters.get('get_jetton_data').stack[0] = { type: 'num', value: '' }; blocked(await f.read());
  const owner = await fixture({ stage: 2 }); owner.getters.get(key(bundle.contracts.treasuryJettonWallet)).stack[1] = await addressStack(bundle.roles.deployer); blocked(await owner.read());
  const admin = await fixture({ stage: 1 }); admin.getters.get('get_jetton_data').stack[2] = await addressStack(bundle.roles.deployer); blocked(await admin.read());
});

test('Deployment console: verified state is not retained across a later RPC failure', async () => {
  const f = await fixture(); assert.equal((await f.read()).steps[1].unlocked, true);
  f.accounts.pop(); blocked(await f.read());
});
