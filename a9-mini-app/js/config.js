/**
 * a9mini 运行模式与数据源配置
 *
 * mode=demo（默认）：
 *   明确标识的演示模式。允许模拟钱包、模拟余额、随机行情、模拟交易哈希与模拟领取；
 *   所有模拟资金行为都集中在 js/demo-data.js，并且不会写入真实模式的持久化存储。
 *
 * mode=live：
 *   只读数据从 BAM Worker 的 /api/* 获取（API 契约见 js/data.js 的 BAM_SOURCE）。
 *   钱包 SDK / 配置 / 接口任一缺失时给出明确异常与重试入口；资金操作在本阶段一律不可用，
 *   等合约版本交付后再按 v13 接入。
 *
 * 注入方式（任选其一，URL 优先）：
 *   ?mode=live&api=http://127.0.0.1:8799
 *   window.__A9_CONFIG__ = { mode: 'live', apiBase: '...' }
 * 本文件不把 mode 写入 localStorage，避免演示模式状态泄漏到真实模式。
 */

const params = new URLSearchParams(window.location.search);
const injected = window.__A9_CONFIG__ || {};

function readMode() {
  const raw = params.get('mode') || injected.mode || 'demo';
  return raw === 'live' ? 'live' : 'demo';
}

function isLoopbackHost(hostname) {
  const h = String(hostname || '').toLowerCase();
  return h === '127.0.0.1' || h === 'localhost' || h === '[::1]' || h === '::1';
}

function parseHttpUrl(raw) {
  const str = String(raw || '').trim();
  if (!str) return null;
  if (/^\/\//.test(str)) return null; // reject protocol-relative URLs
  try {
    const u = new URL(str);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    if (u.username || u.password) return null;
    return u;
  } catch (_) {
    return null;
  }
}

function buildAllowedApiOrigins() {
  const allowed = new Set();
  const pageOrigin = window.location?.origin;
  if (pageOrigin && pageOrigin !== 'null') allowed.add(pageOrigin);

  const injectedUrl = parseHttpUrl(injected.apiBase);
  if (injectedUrl) allowed.add(injectedUrl.origin);

  if (Array.isArray(injected.allowedApiOrigins)) {
    for (const item of injected.allowedApiOrigins) {
      const parsed = parseHttpUrl(item);
      if (parsed) allowed.add(parsed.origin);
    }
  }
  return allowed;
}

function resolveApiBase() {
  const deployedRaw = String(injected.apiBase || '').trim();
  const deployedUrl = parseHttpUrl(deployedRaw);
  const deployedBase = deployedUrl ? deployedUrl.href.replace(/\/+$/, '') : '';

  const paramRaw = params.get('api');
  if (!paramRaw || !paramRaw.trim()) {
    return { apiBase: deployedBase, apiOverrideRejected: false, apiOverrideError: null };
  }

  const candidate = parseHttpUrl(paramRaw);
  if (!candidate) {
    return {
      apiBase: deployedBase,
      apiOverrideRejected: true,
      apiOverrideError: 'URL 参数 api 不是合法的 HTTP(S) 地址，已忽略并回退至部署配置'
    };
  }

  const allowedOrigins = buildAllowedApiOrigins();
  const localDevLoopback = isLoopbackHost(window.location?.hostname) && isLoopbackHost(candidate.hostname);

  if (allowedOrigins.has(candidate.origin) || localDevLoopback) {
    return {
      apiBase: candidate.href.replace(/\/+$/, ''),
      apiOverrideRejected: false,
      apiOverrideError: null
    };
  }

  return {
    apiBase: deployedBase,
    apiOverrideRejected: true,
    apiOverrideError: `未受信任的 API 数据源 (${candidate.origin}) 已被拦截，仅信任部署配置允许的数据源`
  };
}

export const V15_SOURCE = Object.freeze({
  project: 'A9mini',
  protocolVersion: 'v15',
  contractsDir: 'A9mini/v15/',
  workerDir: 'A9mini/worker/',
  spec: '4 合约极简架构（标准 TEP-74 Jetton + RoundController + StakeTicket）+ 0 合约推广热钱包（0.06 GRAM）',
  note: 'Batch A 已关闭 live 资金入口并限制非信任 API URL 覆盖；待 B–F 独立验收通过后再开放实盘。'
});

// 保留别名兼容旧引用
export const BAM_SOURCE = V15_SOURCE;

const resolvedMode = readMode();
const resolvedApi = resolveApiBase();

export const config = Object.freeze({
  mode: resolvedMode,
  apiBase: resolvedApi.apiBase,
  apiOverrideRejected: resolvedApi.apiOverrideRejected,
  apiOverrideError: resolvedApi.apiOverrideError,
  isDemo: resolvedMode === 'demo',
  liveFundsEnabled: false,
  stakeProtocolVersion: injected.stakeProtocolVersion === 'v16' ? 'v16' : 'v15',
  timeoutMs: Number(params.get('timeout')) > 0 ? Number(params.get('timeout')) : 15000,
  pollMs: Number(params.get('poll')) > 0 ? Number(params.get('poll')) : 15000
});

export function apiUrl(path) {
  return `${config.apiBase}${path}`;
}
