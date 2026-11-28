#!/usr/bin/env node
/**
 * 5a 路由收敛与命名统一回归测试
 * - AGENTS.md 中全部历史深链与 ROUTE_ALIASES 旧路由均解析到有效页面且不 404
 * - 规范路径本身绝不触发重定向（防止自循环）
 * - 可见一级 / 二级路由数 <= 12（详情页除外）
 * - /proof 与 /proof/:id 可用；parseStartParam 与 #/round?panel=prediction 既有契约保持不变
 * - 全站前端可见文案无 9 个已淘汰旧名称残留
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const JS_DIR = dirname(fileURLToPath(import.meta.url));
const APP_DIR = join(JS_DIR, '..');

// 提供最小 DOM / window 环境以便加载 router.js 与 i18n.js
if (typeof globalThis.window === 'undefined') {
  globalThis.window = {
    location: { href: 'https://app.a9.lat/?mode=live', origin: 'https://app.a9.lat', protocol: 'https:', hostname: 'app.a9.lat', port: '', pathname: '/', search: '?mode=live', hash: '#/challenge' },
    __A9_CONFIG__: { mode: 'live', lockMode: true, network: 'mainnet', apiBase: 'https://api.a9.lat', liveFundsEnabled: false },
    matchMedia: () => ({ matches: false }),
  };
}
if (typeof globalThis.localStorage === 'undefined') {
  const m = new Map();
  globalThis.localStorage = { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
}
if (typeof globalThis.sessionStorage === 'undefined') {
  const m = new Map();
  globalThis.sessionStorage = { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
}
if (typeof globalThis.document === 'undefined') {
  globalThis.document = { documentElement: { dataset: { theme: 'light' }, lang: 'zh-CN' } };
}

const { ROUTES, VISIBLE_ROUTES, ROUTE_ALIASES, resolveRouteAlias, matchRoute } = await import('./router.js');
const { A9TMA } = await import('./tma.js');
const { store } = await import('./store.js');

test('5a: visible primary/secondary route count is <= 12 and canonical paths never redirect (no self-loop)', () => {
  assert.ok(VISIBLE_ROUTES.length <= 12, `expected visible routes <= 12, got ${VISIBLE_ROUTES.length}`);
  assert.ok(VISIBLE_ROUTES.length >= 10, `expected core canonical routes present, got ${VISIBLE_ROUTES.length}`);

  for (const r of ROUTES) {
    assert.equal(resolveRouteAlias(`#${r.path}`), null, `canonical route ${r.path} must NOT be in ROUTE_ALIASES`);
    assert.equal(
      Object.prototype.hasOwnProperty.call(ROUTE_ALIASES, r.path),
      false,
      `ROUTE_ALIASES must not contain canonical path ${r.path}`
    );
    const matched = matchRoute(`#${r.path}`);
    assert.equal(matched.route.path, r.path, `canonical route ${r.path} must match itself`);
    assert.notEqual(matched.route.path, '/404');
  }
});

test('5a: all AGENTS.md historical deep links and legacy aliases resolve without 404 and preserve query/anchor', () => {
  const cases = [
    // AGENTS.md 历史深链
    { hash: '#/internal/market',              expectPath: '/market',   expectTo: '#/market',                    expectQuery: {},                      expectAnchor: '' },
    { hash: '#/internal/market?tab=free',     expectPath: '/market',   expectTo: '#/market?tab=free',           expectQuery: { tab: 'free' },         expectAnchor: '' },
    { hash: '#/market',                       expectPath: '/market',   expectTo: null,                          expectQuery: {},                      expectAnchor: '' },
    { hash: '#/claim',                        expectPath: '/rewards',  expectTo: '#/rewards',                   expectQuery: {},                      expectAnchor: '' },
    { hash: '#/claim?ticket=EQ_T1',           expectPath: '/rewards',  expectTo: '#/rewards?ticket=EQ_T1',      expectQuery: { ticket: 'EQ_T1' },     expectAnchor: '' },
    { hash: '#/rewards',                      expectPath: '/rewards',  expectTo: null,                          expectQuery: {},                      expectAnchor: '' },
    { hash: '#/warmup',                       expectPath: '/round',    expectTo: '#/round?stage=warmup',        expectQuery: { stage: 'warmup' },     expectAnchor: '' },
    { hash: '#/warmup?round=7',               expectPath: '/round',    expectTo: '#/round?stage=warmup&round=7',expectQuery: { stage: 'warmup', round: '7' }, expectAnchor: '' },
    { hash: '#/warmup/rank',                  expectPath: '/round',    expectTo: '#/round?stage=warmup',        expectQuery: { stage: 'warmup' },     expectAnchor: '' },
    { hash: '#/team/invite',                  expectPath: '/team/invite', expectTo: null,                       expectQuery: {},                      expectAnchor: '' },
    { hash: '#/risk/audit',                   expectPath: '/rules',    expectTo: '#/rules#audit',               expectQuery: {},                      expectAnchor: 'audit' },
    // 其余 5a 别名
    { hash: '#/renew',                        expectPath: '/settings', expectTo: '#/settings',                  expectQuery: {},                      expectAnchor: '' },
    { hash: '#/ledger',                       expectPath: '/records',  expectTo: '#/records?type=ledger',       expectQuery: { type: 'ledger' },      expectAnchor: '' },
    { hash: '#/internal/records',             expectPath: '/records',  expectTo: '#/records?type=market',       expectQuery: { type: 'market' },      expectAnchor: '' },
    { hash: '#/risk/matrix',                  expectPath: '/rules',    expectTo: '#/rules#matrix',              expectQuery: {},                      expectAnchor: 'matrix' },
    { hash: '#/observation/records',          expectPath: '/round',    expectTo: '#/round?stage=charge',        expectQuery: { stage: 'charge' },     expectAnchor: '' },
    { hash: '#/leaderboard',                  expectPath: '/team',     expectTo: '#/team',                      expectQuery: {},                      expectAnchor: '' },
    { hash: '#/gallery',                      expectPath: '/profile',  expectTo: '#/profile',                   expectQuery: {},                      expectAnchor: '' },
    { hash: '#/gallery/act-01',               expectPath: '/profile',  expectTo: '#/profile',                   expectQuery: {},                      expectAnchor: '' },
    { hash: '#/team/bind-tg',                 expectPath: '/team/bind-tg', expectTo: null,                      expectQuery: {},                      expectAnchor: '' },
    // 凭证详情页
    { hash: '#/proof',                        expectPath: '/proof',    expectTo: null,                          expectQuery: {},                      expectAnchor: '' },
    { hash: '#/proof/A9-STAKE-99',            expectPath: '/proof',    expectTo: null,                          expectQuery: {},                      expectAnchor: '', expectParam: 'A9-STAKE-99' },
    // 既有契约：/round?panel=prediction 保持 path=/round 且保留 query.panel
    { hash: '#/round?panel=prediction',       expectPath: '/round',    expectTo: null,                          expectQuery: { panel: 'prediction' }, expectAnchor: '' },
  ];

  for (const c of cases) {
    const alias = resolveRouteAlias(c.hash);
    assert.equal(alias ? alias.to : null, c.expectTo, `alias target mismatch for ${c.hash}`);
    // 若触发重定向，二次解析必须返回 null（无自循环）
    if (alias) {
      assert.equal(resolveRouteAlias(alias.to), null, `alias redirect self-loop detected for ${c.hash} -> ${alias.to}`);
    }
    const matched = matchRoute(alias ? alias.to : c.hash);
    assert.equal(matched.route.path, c.expectPath, `matched path mismatch for ${c.hash}`);
    assert.notEqual(matched.route.path, '/404', `${c.hash} must not 404`);
    assert.deepEqual(matched.query, c.expectQuery, `query mismatch for ${c.hash}`);
    assert.equal(matched.anchor || '', c.expectAnchor, `anchor mismatch for ${c.hash}`);
    if (c.expectParam !== undefined) {
      assert.equal(matched.param, c.expectParam, `param mismatch for ${c.hash}`);
    }
    // 即使未经重定向直接调用 matchRoute(oldHash) 也绝不 404
    const directMatched = matchRoute(c.hash);
    assert.equal(directMatched.route.path, c.expectPath, `direct matchRoute mismatch for ${c.hash}`);
  }

  // 未知路由仍应返回 404
  assert.equal(matchRoute('#/does-not-exist').route.path, '/404');
});

test('5a: unified bilingual titles & retired legacy names removed from user-visible frontend sources', () => {
  const titleByPath = (path, lang) => {
    store.state.settings.language = lang;
    const r = ROUTES.find(item => item.path === path);
    assert.ok(r, `missing route ${path}`);
    return typeof r.title === 'function' ? r.title() : r.title;
  };

  assert.equal(titleByPath('/round', 'zh-CN'), '冲关');
  assert.equal(titleByPath('/round', 'en-US'), 'Quest');
  assert.deepEqual(ROUTES.filter(r => r.shell === 'tab').map(r => r.path), ['/round', '/rewards', '/market', '/team']);
  assert.equal(titleByPath('/rewards', 'zh-CN'), '金库');
  assert.equal(titleByPath('/rewards', 'en-US'), 'Vault');
  assert.equal(titleByPath('/market', 'zh-CN'), '宝箱');
  assert.equal(titleByPath('/market', 'en-US'), 'Chest');
  assert.equal(titleByPath('/team', 'zh-CN'), '战队');
  assert.equal(titleByPath('/team', 'en-US'), 'Squad');
  assert.equal(titleByPath('/profile', 'zh-CN'), '我的');
  assert.equal(titleByPath('/profile', 'en-US'), 'Me');
  assert.equal(titleByPath('/records', 'zh-CN'), '记录');
  assert.equal(titleByPath('/records', 'en-US'), 'Records');
  assert.equal(titleByPath('/rules', 'zh-CN'), '规则与透明');
  assert.equal(titleByPath('/rules', 'en-US'), 'Rules & Transparency');
  assert.equal(titleByPath('/settings', 'zh-CN'), '设置');
  assert.equal(titleByPath('/settings', 'en-US'), 'Settings');
  assert.equal(titleByPath('/proof', 'zh-CN'), '闯关凭证');
  assert.equal(titleByPath('/proof', 'en-US'), 'Quest Pass');

  // 确认旧名称已从前端代码与 index.html 清除
  const legacyNames = ['A9 广场', '我的档案', '奖金金库', '金库领奖', '轮次闯关', '本轮战场', '用户指南', '闯关指南', '玩法规则'];
  const filesToCheck = [
    join(APP_DIR, 'index.html'),
    join(JS_DIR, 'i18n.js'),
    join(JS_DIR, 'router.js'),
    join(JS_DIR, 'app.js'),
    join(JS_DIR, 'poster.js'),
    join(JS_DIR, 'pages/plaza.js'),
    join(JS_DIR, 'pages/round_hub.js'),
    join(JS_DIR, 'pages/round_stages.js'),
    join(JS_DIR, 'pages/wealthverse.js'),
    join(JS_DIR, 'pages/user-guide.js'),
    join(JS_DIR, 'pages/system.js'),
    join(JS_DIR, 'pages/profile.js'),
    join(JS_DIR, 'pages/team.js'),
    join(JS_DIR, 'pages/warmup_market.js'),
  ];
  for (const file of filesToCheck) {
    const src = readFileSync(file, 'utf8');
    // 剔除行注释与块注释后再校验用户可见文本源
    const noComments = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    for (const term of legacyNames) {
      assert.equal(noComments.includes(term), false, `legacy name "${term}" still present in ${file}`);
    }
  }

  // 保留 parseStartParam 既有契约：claim -> /claim, gallery_* -> /gallery
  globalThis.window.location.search = '?startapp=claim';
  assert.equal(A9TMA.parseStartParam()?.route, '/claim');
  globalThis.window.location.search = '?startapp=gallery_act-01_1001';
  assert.equal(A9TMA.parseStartParam()?.route, '/gallery');
});
