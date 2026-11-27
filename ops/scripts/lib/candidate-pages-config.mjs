// v17 独立候选测试网 Pages 的运行配置生成器（纯函数，无副作用）。
// 目的：候选 runtime-config 的单一来源，可被测试覆盖；部署脚本只负责落盘与上传。
// 硬约束：live + lockMode + testnet；资金总闸默认关闭；必须显式注入独立测试 Bot 句柄，
// 钱包回跳（twaReturnUrl）才不会回落到正式 Bot。
const PRODUCTION_BOT_HANDLE = 'A9_TonBot';
const BOT_HANDLE_RE = /^[A-Za-z0-9_]{5,64}$/;

export const CANDIDATE_TEST_BOT_HANDLE = 'A9_TestnetBot';

function normalizeHandle(raw) {
  const s = String(raw || '').replace(/^@+/, '').trim();
  return BOT_HANDLE_RE.test(s) ? s : '';
}

function assertHttpsOrigin(raw, label) {
  let u;
  try { u = new URL(String(raw || '').trim()); } catch { throw new Error(`${label} must be a valid URL`); }
  if (u.protocol !== 'https:') throw new Error(`${label} must be https`);
  if (u.username || u.password || raw.includes('@')) throw new Error(`${label} must not carry credentials`);
  if (u.pathname !== '/' || u.search || u.hash) throw new Error(`${label} must be a bare origin`);
  return u.origin;
}

/** 候选 Pages 不得使用生产域名。 */
export const PRODUCTION_HOSTS = new Set(['app.a9.lat', 'api.a9.lat', 'a9.lat']);
function assertNotProduction(origin, label) {
  const host = new URL(origin).hostname;
  if (PRODUCTION_HOSTS.has(host)) throw new Error(`${label} must not point at a production host`);
}

/**
 * @param {{ apiOrigin: string, liveFundsEnabled?: boolean, botHandle?: string }} input
 * @returns Readonly<Record<string, unknown>>
 */
export function buildCandidateRuntimeConfig({ apiOrigin, liveFundsEnabled, botHandle = CANDIDATE_TEST_BOT_HANDLE } = {}) {
  // 不给默认值：资金总闸必须由调用方显式声明，缺省即报错（失败关闭）。
  if (typeof liveFundsEnabled !== 'boolean') throw new Error('liveFundsEnabled must be an explicit boolean');
  const apiBase = assertHttpsOrigin(apiOrigin, 'apiOrigin');
  assertNotProduction(apiBase, 'apiOrigin');
  const handle = normalizeHandle(botHandle);
  if (!handle) throw new Error('botHandle must be a valid Telegram bot username');
  if (handle.toLowerCase() === PRODUCTION_BOT_HANDLE.toLowerCase()) throw new Error(`botHandle must not be the production handle ${PRODUCTION_BOT_HANDLE}`);
  return Object.freeze({
    mode: 'live',
    lockMode: true,
    network: 'testnet',
    apiBase,
    allowedApiOrigins: Object.freeze([apiBase]),
    liveFundsEnabled,
    botHandle: handle,
    stakeProtocolVersion: 'v17',
  });
}

export function renderRuntimeConfigJs(cfg, comment = '/** 独立 v17 Testnet 候选环境运行配置（绝非主网）。 */') {
  return `${comment}\nwindow.__A9_CONFIG__ = ${JSON.stringify(cfg, null, 2)};\n`;
}

export function buildCandidateManifest(pagesOrigin) {
  const origin = assertHttpsOrigin(pagesOrigin, 'pagesOrigin');
  assertNotProduction(origin, 'pagesOrigin');
  return {
    url: origin,
    name: 'A9 · 财富大冒险 [Testnet]',
    iconUrl: `${origin}/assets/token/a9-token-2048.png`,
    termsOfUseUrl: `${origin}/terms.html`,
    privacyPolicyUrl: `${origin}/privacy.html`,
  };
}

export function buildCandidateTokenMetadata(pagesOrigin, botHandle = CANDIDATE_TEST_BOT_HANDLE) {
  const origin = assertHttpsOrigin(pagesOrigin, 'pagesOrigin');
  assertNotProduction(origin, 'pagesOrigin');
  const handle = normalizeHandle(botHandle);
  if (!handle || handle.toLowerCase() === PRODUCTION_BOT_HANDLE.toLowerCase()) throw new Error('botHandle must be an isolated test bot username');
  return {
    name: 'A9',
    symbol: 'A9',
    decimals: '9',
    description: 'A9 · Wealth Quest (TON Testnet Candidate v17.0) — 10,000,000,000 fixed supply TON Jetton powering the Price-Unlock protocol.',
    image: `${origin}/assets/token/a9-token-2048.png`,
    websites: [origin],
    social: [`https://t.me/${handle}`],
  };
}
