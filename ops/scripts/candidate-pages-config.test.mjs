// 候选 Pages 运行配置生成器回归：锁定 live + testnet + 资金关闭 + 测试 Bot 句柄，拒绝生产值。
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildCandidateManifest,
  buildCandidateRuntimeConfig,
  buildCandidateTokenMetadata,
  renderRuntimeConfigJs,
} from './lib/candidate-pages-config.mjs';

const API = 'https://a9-v17-testnet-candidate.348421501.workers.dev';
const PAGES = 'https://a9-v17-testnet-candidate.pages.dev';

test('candidate runtime config is locked to live + lockMode + testnet with funds disabled and the test bot handle', () => {
  const cfg = buildCandidateRuntimeConfig({ apiOrigin: API, liveFundsEnabled: false });
  assert.equal(cfg.mode, 'live');
  assert.equal(cfg.lockMode, true);
  assert.equal(cfg.network, 'testnet');
  assert.equal(cfg.liveFundsEnabled, false);
  assert.equal(cfg.botHandle, 'A9_TestnetBot');
  assert.deepEqual(cfg.allowedApiOrigins, [API]);
  assert.equal(cfg.stakeProtocolVersion, 'v17');
  assert.ok(Object.isFrozen(cfg));

  const js = renderRuntimeConfigJs(cfg);
  assert.ok(js.startsWith('/**'));
  assert.ok(js.includes('window.__A9_CONFIG__ = {'));
  const sandbox = {};
  new Function('window', js)({ __A9_CONFIG__: undefined, ...sandbox });
  // 渲染结果可被浏览器原样执行并还原同一份配置
  const holder = {};
  new Function('window', js)(holder);
  assert.deepEqual(holder.__A9_CONFIG__, { ...cfg, allowedApiOrigins: [API] });
});

test('candidate runtime config rejects the production bot handle, invalid handles and non-test inputs', () => {
  for (const bad of ['A9_TonBot', 'a9_tonbot', 'A9_TONBOT', '@a9_TonBot', '@A9_TONBOT']) {
    assert.throws(() => buildCandidateRuntimeConfig({ apiOrigin: API, liveFundsEnabled: false, botHandle: bad }), /production handle/, bad);
  }
  for (const bad of ['', 'bad handle!', 'https://evil.example', 'ab']) {
    assert.throws(() => buildCandidateRuntimeConfig({ apiOrigin: API, liveFundsEnabled: false, botHandle: bad }), /valid Telegram bot username/);
  }
  assert.throws(() => buildCandidateRuntimeConfig({ apiOrigin: API, liveFundsEnabled: 'true' }), /explicit boolean/);
  assert.throws(() => buildCandidateRuntimeConfig({ apiOrigin: API, liveFundsEnabled: undefined }), /explicit boolean/);
  assert.equal(buildCandidateRuntimeConfig({ apiOrigin: API, liveFundsEnabled: false, botHandle: '@A9_TestnetBot' }).botHandle, 'A9_TestnetBot');
});

test('candidate pages config never accepts production hosts or non-https origins', () => {
  for (const bad of ['https://api.a9.lat', 'https://app.a9.lat', 'http://a9-v17-testnet-candidate.348421501.workers.dev', 'https://user:pw@example.dev', 'https://example.dev/api']) {
    assert.throws(() => buildCandidateRuntimeConfig({ apiOrigin: bad }), undefined, bad);
  }
  assert.throws(() => buildCandidateManifest('https://app.a9.lat'), /production host/);
  assert.throws(() => buildCandidateTokenMetadata('https://app.a9.lat'), /production host/);
});

test('candidate manifest and token metadata point only at the candidate pages origin and the test bot', () => {
  const manifest = buildCandidateManifest(PAGES);
  assert.equal(manifest.url, PAGES);
  assert.match(manifest.name, /\[Testnet\]/);
  for (const v of Object.values(manifest)) assert.ok(v.startsWith(PAGES) || v.includes('[Testnet]'), v);
  const meta = buildCandidateTokenMetadata(PAGES);
  assert.deepEqual(meta.websites, [PAGES]);
  assert.deepEqual(meta.social, ['https://t.me/A9_TestnetBot']);
  for (const bad of ['A9_TonBot', 'a9_tonbot', 'A9_TONBOT', '@a9_TonBot']) {
    assert.throws(() => buildCandidateTokenMetadata(PAGES, bad), /isolated test bot/, bad);
  }
});
