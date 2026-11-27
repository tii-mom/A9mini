// A9 v17 — 候选环境时序参数一致性与防静默默认值回归测试
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateCandidateEnv } from '../src/cf-worker.mjs';
import { buildV15ConfigPayload } from '../src/v15-indexer.mjs';
import { PROFILES } from '../../ops/scripts/lib/v15-core.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../..');

const FAST = PROFILES['testnet-fast'].timing;
const BASE_VALID_CANDIDATE_ENV = Object.freeze({
  DB: {},
  A9_ENVIRONMENT: 'candidate',
  A9_PROTOCOL_VERSION: 'v17',
  A9_NETWORK: 'testnet',
  A9_STAKE_SECONDS: String(FAST.stakeDurationSeconds),
  A9_EARLY_WINDOW_SECONDS: String(FAST.earlyWindowSeconds),
  A9_OBS_SECONDS: String(FAST.observationSeconds),
  A9_ABORT_TIMEOUT_SECONDS: String(FAST.abortTimeoutSeconds),
  A9_VESTING_SECONDS: String(FAST.vestingSeconds),
  A9_JETTON_MASTER_ADDRESS: 'kQAYm31nAaivM1Xf5QRa6rWScWrrYBNgAOQCEWcDR8WFwBr1',
  A9_ROUND_CONTROLLER_ADDRESS: 'kQCqh657Pt1LpQQWpherJOWcz6YG-wS_xpGFLMcRLxROgpm_',
  A9_PROMO_HOT_WALLET_ADDRESS: 'kQBhFPLiPKieziv4cyb1r9V2qrqfONi0GbgP7t4-UIOFmp3u',
  A9_PRESALE_HOT_WALLET_ADDRESS: 'kQD_atnwZbQa7ww2Ev2eLM2qCyPEMkXtVNyT1FOEsSLczEra',
  A9_PUBLIC_ORIGIN: 'https://a9-v17-testnet-candidate.pages.dev',
  A9_TON_PROOF_DOMAINS: 'a9-v17-testnet-candidate.pages.dev',
  A9_ALLOWED_ORIGINS: 'https://a9-v17-testnet-candidate.pages.dev',
  A9_TG_BOT_HANDLE: 'A9_TestnetBot',
});

function parseTomlSectionVars(tomlText, sectionHeader) {
  const lines = tomlText.split(/\r?\n/);
  const out = {};
  let inSection = false;
  for (const raw of lines) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    if (line.startsWith('[')) {
      inSection = line === sectionHeader;
      continue;
    }
    if (!inSection) continue;
    const m = line.match(/^([A-Z0-9_]+)\s*=\s*"([^"]*)"$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

test('candidate environment fails closed if any timing variable is missing or invalid (never silently falls back to mainnet defaults)', () => {
  const ok = validateCandidateEnv(BASE_VALID_CANDIDATE_ENV);
  assert.equal(ok.ok, true);

  for (const key of [
    'A9_STAKE_SECONDS',
    'A9_EARLY_WINDOW_SECONDS',
    'A9_OBS_SECONDS',
    'A9_ABORT_TIMEOUT_SECONDS',
    'A9_VESTING_SECONDS',
  ]) {
    const missingEnv = { ...BASE_VALID_CANDIDATE_ENV };
    delete missingEnv[key];
    const rMissing = validateCandidateEnv(missingEnv);
    assert.equal(rMissing.ok, false, `missing ${key} must fail closed`);
    assert.equal(rMissing.code, 'CANDIDATE_CONFIG_INCOMPLETE');
    assert.ok(rMissing.missing.includes(key), `missing list must report ${key}`);

    const badEnv = { ...BASE_VALID_CANDIDATE_ENV, [key]: '0' };
    const rBad = validateCandidateEnv(badEnv);
    assert.equal(rBad.ok, false, `non-positive ${key} must fail closed`);
    assert.ok(rBad.missing.includes(key));
  }

  // 头矿窗口不得大于锁仓总时长
  const badEarly = validateCandidateEnv({
    ...BASE_VALID_CANDIDATE_ENV,
    A9_STAKE_SECONDS: '60',
    A9_EARLY_WINDOW_SECONDS: '120',
  });
  assert.equal(badEarly.ok, false);
  assert.ok(badEarly.missing.includes('A9_EARLY_WINDOW_SECONDS<=A9_STAKE_SECONDS'));

  // 冲价观察总时长必须可整除 12 根 K 线
  const badObs = validateCandidateEnv({
    ...BASE_VALID_CANDIDATE_ENV,
    A9_OBS_SECONDS: '65',
  });
  assert.equal(badObs.ok, false);
  assert.ok(badObs.missing.includes('A9_OBS_SECONDS%12==0'));
});

test('buildV15ConfigPayload exposes all 7 testnet-fast timing parameters matching PROFILES["testnet-fast"]', () => {
  const cfg = buildV15ConfigPayload(BASE_VALID_CANDIDATE_ENV, null);
  assert.equal(cfg.stakeDurationSeconds, FAST.stakeDurationSeconds);
  assert.equal(cfg.earlyWindowSeconds, FAST.earlyWindowSeconds);
  assert.equal(cfg.observationSeconds, FAST.observationSeconds);
  assert.equal(cfg.candleCount, FAST.candleCount);
  assert.equal(cfg.minQualifiedCandles, FAST.minQualifiedCandles);
  assert.equal(cfg.abortTimeoutSeconds, FAST.abortTimeoutSeconds);
  assert.equal(cfg.vestingSeconds, FAST.vestingSeconds);
});

test('worker/wrangler.toml [env.candidate.vars] and ops/scripts/local-v17-candidate.mjs match PROFILES["testnet-fast"] timing exactly', () => {
  const wranglerText = readFileSync(resolve(REPO_ROOT, 'worker/wrangler.toml'), 'utf8');
  const candVars = parseTomlSectionVars(wranglerText, '[env.candidate.vars]');
  assert.equal(Number(candVars.A9_STAKE_SECONDS), FAST.stakeDurationSeconds);
  assert.equal(Number(candVars.A9_EARLY_WINDOW_SECONDS), FAST.earlyWindowSeconds);
  assert.equal(Number(candVars.A9_OBS_SECONDS), FAST.observationSeconds);
  assert.equal(Number(candVars.A9_ABORT_TIMEOUT_SECONDS), FAST.abortTimeoutSeconds);
  assert.equal(Number(candVars.A9_VESTING_SECONDS), FAST.vestingSeconds);

  // 同时断言生产配置四道闸保持关闭未改动
  const prodVars = parseTomlSectionVars(wranglerText, '[env.production.vars]');
  assert.equal(prodVars.A9_PRESALE_OPEN, '0');
  assert.equal(prodVars.A9_CHEST_OPEN_ENABLED, '0');
  assert.equal(prodVars.A9_BROADCAST_ENABLED, '0');
  assert.equal(prodVars.A9_TG_BOT_HANDLE, 'A9_TonBot');
  // 候选段必须使用独立测试 Bot 句柄，绝不能写正式句柄
  assert.equal(candVars.A9_TG_BOT_HANDLE, 'A9_TestnetBot');
  // 候选段下单 / 免费箱 / 播报三道闸保持关闭
  assert.equal(candVars.A9_PRESALE_OPEN, '0');
  assert.equal(candVars.A9_CHEST_OPEN_ENABLED, '0');
  assert.equal(candVars.A9_BROADCAST_ENABLED, '0');

  // 检查本地隔离候选脚本绑定的 5 项 timing 与 testnet-fast 完全一致
  const localSrc = readFileSync(resolve(REPO_ROOT, 'ops/scripts/local-v17-candidate.mjs'), 'utf8');
  const extractBinding = (k) => localSrc.match(new RegExp(`${k}:\\s*'(\\d+)'`))?.[1];
  assert.equal(Number(extractBinding('A9_STAKE_SECONDS')), FAST.stakeDurationSeconds);
  assert.equal(Number(extractBinding('A9_EARLY_WINDOW_SECONDS')), FAST.earlyWindowSeconds);
  assert.equal(Number(extractBinding('A9_OBS_SECONDS')), FAST.observationSeconds);
  assert.equal(Number(extractBinding('A9_ABORT_TIMEOUT_SECONDS')), FAST.abortTimeoutSeconds);
  assert.equal(Number(extractBinding('A9_VESTING_SECONDS')), FAST.vestingSeconds);
});

test('candidate environment fails closed when the Bot handle is missing or equals the production handle (never silently falls back to A9_TonBot)', () => {
  const missingEnv = { ...BASE_VALID_CANDIDATE_ENV };
  delete missingEnv.A9_TG_BOT_HANDLE;
  const rMissing = validateCandidateEnv(missingEnv);
  assert.equal(rMissing.ok, false);
  assert.equal(rMissing.code, 'CANDIDATE_CONFIG_INCOMPLETE');
  assert.ok(rMissing.missing.includes('A9_TG_BOT_HANDLE'));

  for (const bad of ['', '   ', 'A9_TonBot', '@A9_TonBot', 'a9_tonbot', 'A9_TONBOT', '@a9_TonBot']) {
    const r = validateCandidateEnv({ ...BASE_VALID_CANDIDATE_ENV, A9_TG_BOT_HANDLE: bad });
    assert.equal(r.ok, false, `handle "${bad}" must fail closed`);
    assert.equal(r.code, 'CANDIDATE_CONFIG_INCOMPLETE');
  }
  assert.ok(validateCandidateEnv({ ...BASE_VALID_CANDIDATE_ENV, A9_TG_BOT_HANDLE: '@A9_TestnetBot' }).ok);

  // 空占位（仓库 [env.candidate.vars] 其余项为空）继续失败关闭，且不得回落到任何生产默认值
  const placeholders = parseTomlSectionVars(readFileSync(resolve(REPO_ROOT, 'worker/wrangler.toml'), 'utf8'), '[env.candidate.vars]');
  const r = validateCandidateEnv({ DB: {}, ...placeholders });
  assert.equal(r.ok, false);
  for (const key of ['A9_PUBLIC_ORIGIN', 'A9_TON_PROOF_DOMAINS', 'A9_ALLOWED_ORIGINS', 'A9_JETTON_MASTER_ADDRESS', 'A9_ROUND_CONTROLLER_ADDRESS', 'A9_PROMO_HOT_WALLET_ADDRESS', 'A9_PRESALE_HOT_WALLET_ADDRESS']) {
    assert.ok(r.missing.includes(key), `${key} placeholder must keep failing closed`);
  }
});
