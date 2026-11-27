import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const JS_DIR = dirname(fileURLToPath(import.meta.url));
const JS_URL = pathToFileURL(JS_DIR).href;

/** 仅提取 HTML 渲染结果中的用户可见文本节点（剥离标签、属性、svg/script/style），严禁扫描 .js 源码全文。 */
function extractVisibleText(html) {
  return String(html || '')
    .replace(/<(script|style|svg)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 检测可见文本中是否出现禁用工程词或旧命名。 */
function findForbiddenVisibleTerms(text) {
  const hits = [];
  const checks = [
    ['SDK', /\bSDK\b/],
    ['STATUS', /\bSTATUS\b/],
    ['StakeTicket', /StakeTicket/i],
    ['AbortRound', /AbortRound/i],
    ['我的档案', /我的档案/],
    ['奖金金库', /奖金金库/],
    ['金库领奖', /金库领奖/],
  ];
  for (const [label, re] of checks) {
    if (re.test(text)) hits.push(label);
  }
  return hits;
}

/** 统计 HTML 中 btn-primary 数量（排除注释与属性干扰）。 */
function countPrimaryButtons(html) {
  const matches = String(html || '').match(/class="[^"]*\bbtn-primary\b[^"]*"/g);
  return matches ? matches.length : 0;
}

/** 检测某 HTML 是否在 .card 容器内嵌套了带框阴影的 .sw-menu-group（卡片套卡片）。 */
function hasCardNestedMenuGroup(html) {
  const tokens = String(html || '').match(/<\/?(section|div)\b[^>]*>/gi) || [];
  let cardDepth = 0;
  const stack = [];
  for (const tok of tokens) {
    if (tok.startsWith('</')) {
      const top = stack.pop();
      if (top === 'card') cardDepth = Math.max(0, cardDepth - 1);
      continue;
    }
    const isCard = /class="[^"]*\bcard\b[^"]*"/i.test(tok);
    const isMenuGroup = /class="[^"]*\bsw-menu-group\b[^"]*"/i.test(tok);
    if (cardDepth > 0 && isMenuGroup) return true;
    stack.push(isCard ? 'card' : 'other');
    if (isCard) cardDepth += 1;
  }
  return false;
}

function runRenderHarness({ mode = 'live', lang = 'zh-CN' } = {}) {
  const script = `
    const storageMap = new Map([['a9_ui_prefs_v1', JSON.stringify({ settings: { language: ${JSON.stringify(lang)}, themeMode: 'light' } })]]);
    const makeEl = (withChildStub = false) => {
      const el = {
        id: '',
        dataset: {},
        style: {},
        isConnected: true,
        open: false,
        _html: '',
        get innerHTML() { return this._html; },
        set innerHTML(v) { this._html = String(v); },
        classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
        setAttribute() {},
        getAttribute() { return null; },
        removeAttribute() {},
        addEventListener() {},
        removeEventListener() {},
        appendChild() {},
        append() {},
        replaceWith() {},
        remove() {},
        scrollIntoView() {},
        getContext() {
          return new Proxy({}, {
            get(_t, prop) {
              if (prop === 'measureText') return () => ({ width: 20 });
              if (prop === 'createLinearGradient' || prop === 'createRadialGradient') return () => ({ addColorStop() {} });
              return () => {};
            },
            set() { return true; },
          });
        },
        querySelector() { return withChildStub ? makeEl(true) : null; },
        querySelectorAll() { return []; },
      };
      return el;
    };
    globalThis.localStorage = {
      getItem: (k) => (storageMap.has(k) ? storageMap.get(k) : null),
      setItem: (k, v) => storageMap.set(k, String(v)),
      removeItem: (k) => storageMap.delete(k),
    };
    globalThis.sessionStorage = { getItem: () => null, setItem() {}, removeItem() {} };
    Object.defineProperty(globalThis, 'navigator', { value: { language: ${JSON.stringify(lang)} }, configurable: true });
    globalThis.window = {
      __A9_CONFIG__: { mode: ${JSON.stringify(mode)}, network: 'testnet', apiBase: 'https://api.example.invalid', liveFundsEnabled: false },
      location: { href: 'https://app.example.invalid/?mode=' + ${JSON.stringify(mode)}, origin: 'https://app.example.invalid', pathname: '/', search: '?mode=' + ${JSON.stringify(mode)}, hash: '#/challenge' },
      addEventListener() {},
      removeEventListener() {},
      dispatchEvent() {},
      scrollTo() {},
    };
    globalThis.document = {
      documentElement: { dataset: { theme: 'light' }, lang: ${JSON.stringify(lang)} },
      body: { dataset: {}, classList: { add() {}, remove() {}, toggle() {} }, appendChild() {} },
      addEventListener() {},
      createElement: () => makeEl(true),
      getElementById: () => makeEl(true),
      querySelector: () => null,
      querySelectorAll: () => [],
    };
    globalThis.requestAnimationFrame = () => 0;
    globalThis.setInterval = () => 0;
    globalThis.clearInterval = () => {};
    globalThis.Image = class { set src(_) {} };
    globalThis.fetch = async (url) => {
      const u = String(url);
      if (u.includes('/api/warmup/current')) {
        return {
          ok: true, status: 200,
          async json() {
            return {
              ok: true,
              data: {
                targetRoundId: 7, totalRegistered: 3, openingAt: null, myRegistration: null,
                config: {
                  chestBaseRewardRaw: '300000000000',
                  chestBonusPerInviteRaw: '100000000000',
                  chestMinInvites: 1,
                  chestMaxInvites: 5,
                  chestMaxRewardRaw: '700000000000',
                },
              },
              ts: Date.now(),
            };
          },
        };
      }
      return { ok: true, status: 200, async json() { return { ok: true, data: {}, ts: Date.now() }; } };
    };

    const { store } = await import(${JSON.stringify(JS_URL)} + '/store.js');
    const i18n = await import(${JSON.stringify(JS_URL)} + '/i18n.js');
    const { renderCity } = await import(${JSON.stringify(JS_URL)} + '/pages/plaza.js');
    const { renderChallengeHome } = await import(${JSON.stringify(JS_URL)} + '/pages/round_hub.js');
    const { renderMyRewardsPage } = await import(${JSON.stringify(JS_URL)} + '/pages/rewards.js');
    const { mountWarmupSection } = await import(${JSON.stringify(JS_URL)} + '/pages/warmup_market.js');
    const { renderTeamHome, renderInviteShare } = await import(${JSON.stringify(JS_URL)} + '/pages/team.js');
    const { renderProfileHome, renderProofDetail, renderRecordsPage } = await import(${JSON.stringify(JS_URL)} + '/pages/profile.js');
    const { renderUserGuide } = await import(${JSON.stringify(JS_URL)} + '/pages/user-guide.js');
    const { renderSettingsPage, renderRiskAudit, renderRiskMatrix } = await import(${JSON.stringify(JS_URL)} + '/pages/system.js');

    const nowSec = Math.floor(Date.now() / 1000);
    store.update((s) => {
      s.settings.language = ${JSON.stringify(lang)};
      s.round.currentRound = 6;
      s.round.rawState = 'OBSERVING';
      s.round.observationEndAt = nowSec + 3600;
      s.round.targetPrice = 0.0046;
      s.round.livePrice = 0.0048;
      s.round.priceValid = true;
      s.round.qualifiedCandles = 6;
      s.round.minQualifiedCandles = 8;
      s.round.candlesSeen = 8;
      s.round.rewardBudgetA9 = 700000000;
      s.round.detailLoading = false;
      s.round.protocolConfig = { network: 'testnet', contracts: { roundController: 'kQCqh657Pt1LpQQWpherJOWcz6YG-wS_xpGFLMcRLxROgpm_' } };
      if (${JSON.stringify(mode)} === 'demo') {
        s.user.connected = true;
        s.user.address = 'UQDemoAddress0001';
        s.user.a9Available = 12000;
        s.user.tonBalance = 8.5;
        s.user.a9Claimable = 3500;
        s.user.promoClaimableA9 = 600;
        s.user.a9Locked = 4000;
        s.certificates = [{
          id: 'A9-STAKE-R06-100001',
          round: 6,
          stakeTon: 5000,
          multiplier: 1,
          estRewardA9: 2500,
          status: 'observation',
          txHash: 'EQDemoProofHash1234',
          timestamp: '2026-11-27 12:00 UTC',
        }];
      }
    });

    const i18nKeys = [
      'tab_challenge','tab_market','tab_round','tab_backpack','tab_team','tab_leaderboard','tab_profile',
      'connect_wallet','rt_confirm','rt_success','rt_warmup','rt_warmup_rank','rt_market','rt_market_rec',
      'rt_team_profile','rt_bind_tg','rt_invite','rt_claim','rt_proof','rt_renew','rt_ledger','rt_records',
      'rt_settings','rt_risk_matrix','rt_risk_audit','rt_rules'
    ];
    const i18nValues = i18nKeys.map((k) => i18n.t(k));

    const pages = {};
    const capture = (name, fn) => {
      const r = makeEl(true);
      fn(r);
      pages[name] = r.innerHTML;
    };

    capture('plaza', (r) => renderCity(r, () => {}));
    capture('quest_charge', (r) => renderChallengeHome(r, () => {}, null, {}));
    store.update((s) => { s.round.rawState = 'SUCCEEDED'; s.round.qualifiedCandles = 9; });
    capture('quest_passed', (r) => renderChallengeHome(r, () => {}, null, {}));
    capture('rewards', (r) => renderMyRewardsPage(r, () => {}));
    capture('team_default', (r) => renderTeamHome(r, () => {}, null, {}));
    if (${JSON.stringify(mode)} === 'demo') {
      store.update((s) => { s.team.role = 'member'; });
      capture('team_member', (r) => renderTeamHome(r, () => {}, null, {}));
      store.update((s) => { s.team.role = 'none'; });
      capture('team_unjoined', (r) => renderTeamHome(r, () => {}, null, {}));
      store.update((s) => { s.team.role = 'captain'; });
    }
    capture('team_invite', (r) => renderInviteShare(r));
    capture('profile', (r) => renderProfileHome(r, () => {}));
    capture('proof', (r) => renderProofDetail(r, () => {}, null));
    capture('records', (r) => renderRecordsPage(r, () => {}, null, {}));
    capture('rules', (r) => renderUserGuide(r, () => {}, null, {}));
    capture('rules_audit', (r) => renderRiskAudit(r));
    capture('rules_matrix', (r) => renderRiskMatrix(r));
    capture('settings', (r) => renderSettingsPage(r));

    const warmupRoot = makeEl(false);
    mountWarmupSection(warmupRoot, { navigate: () => {}, embedded: true });
    await new Promise((r) => setTimeout(r, 40));
    pages.warmup = warmupRoot.innerHTML;

    console.log(JSON.stringify({ i18nValues, pages }));
  `;
  const raw = execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
  return JSON.parse(raw.trim().split('\n').at(-1));
}

test('5e 禁用词守卫：仅扫描 i18n 字典值与各主要页面渲染可见文本节点（中英双语 × Live/Demo），严禁扫描源码全文', () => {
  for (const combo of [
    { mode: 'live', lang: 'zh-CN' },
    { mode: 'live', lang: 'en-US' },
    { mode: 'demo', lang: 'zh-CN' },
    { mode: 'demo', lang: 'en-US' },
  ]) {
    const out = runRenderHarness(combo);
    // 1. i18n 字典值检查
    const i18nHits = findForbiddenVisibleTerms(out.i18nValues.join(' '));
    assert.deepEqual(i18nHits, [], `i18n (${combo.lang}) contains forbidden visible terms: ${i18nHits}`);

    // 2. 各主要页面可见文本节点检查 + btn-primary <= 1
    for (const [pageName, html] of Object.entries(out.pages)) {
      const visible = extractVisibleText(html);
      const hits = findForbiddenVisibleTerms(visible);
      assert.deepEqual(hits, [], `${combo.mode}/${combo.lang} page "${pageName}" visible text contains forbidden terms: ${hits}`);

      const primaryCount = countPrimaryButtons(html);
      assert.ok(primaryCount <= 1, `${combo.mode}/${combo.lang} page "${pageName}" has ${primaryCount} btn-primary (must be <= 1)`);
    }
  }
});

test('5e 结构与去噪守卫：战队/我的极简块数、清除行情条/废按钮/套卡片/自循环/跨界雷达盘、22 条错误码折叠与顶栏 3 项菜单', () => {
  const liveZh = runRenderHarness({ mode: 'live', lang: 'zh-CN' });
  const demoZh = runRenderHarness({ mode: 'demo', lang: 'zh-CN' });

  // 1. 战队页：无 .sw-battle-strip、无「群广播未开放」、无卡片套 .sw-menu-group、无 #/leaderboard 自循环、有返佣直链 #/rewards 与我的排名
  for (const [label, html] of [
    ['live team', liveZh.pages.team_default],
    ['demo captain', demoZh.pages.team_default],
    ['demo member', demoZh.pages.team_member],
    ['demo unjoined', demoZh.pages.team_unjoined],
  ]) {
    assert.ok(!html.includes('sw-battle-strip'), `${label} must remove .sw-battle-strip`);
    assert.ok(!html.includes('群广播未开放') && !html.includes('Broadcast Off'), `${label} must remove disabled broadcast button`);
    assert.ok(!html.includes('#/leaderboard'), `${label} must not self-loop via #/leaderboard`);
    assert.equal(hasCardNestedMenuGroup(html), false, `${label} must not nest .sw-menu-group inside .card`);
    assert.ok(html.includes('href="#/rewards"'), `${label} must link referral summary to #/rewards`);
    assert.ok(html.includes('id="team-ranking-card"'), `${label} must include my rank row`);
    // 统计顶层块数量 <= 4（首屏 ≤ 4 块、全页 ≤ 8 块）
    const topBlocks = (html.match(/<(section|form|div)\b[^>]*id="(team-overview-card|live-join-team-form|team-recommended-card|team-commission-summary|team-ranking-card)"/g) || []).length;
    assert.ok(topBlocks >= 2 && topBlocks <= 4, `${label} top block count ${topBlocks} must be <= 4`);
  }

  // 2. #/team/invite：彻底修复「明细 ›」自循环且无卡片套 .sw-menu-group
  for (const html of [liveZh.pages.team_invite, demoZh.pages.team_invite]) {
    assert.ok(!html.includes('href="#/team/invite"'), '#/team/invite must not contain self-loop link href="#/team/invite"');
    assert.ok(html.includes('href="#/rewards"'), '#/team/invite should guide users to #/rewards');
    assert.equal(hasCardNestedMenuGroup(html), false, '#/team/invite must not nest .sw-menu-group inside .card');
  }

  // 3. 我的主页：仅 2 块（资产主卡含唯一主按钮 + 一张 4 项列表卡：记录 / 规则与透明 / 设置 / 语言与主题）
  for (const [label, html] of [['live profile', liveZh.pages.profile], ['demo profile', demoZh.pages.profile]]) {
    assert.ok(html.includes('id="profile-asset-card"'), `${label} must render asset card`);
    assert.ok(html.includes('id="profile-main-menu"'), `${label} must render single 4-row menu card`);
    assert.ok(html.includes('href="#/records"'), `${label} menu must link to #/records`);
    assert.ok(html.includes('href="#/rules"'), `${label} menu must link to #/rules`);
    assert.ok(html.includes('href="#/settings"'), `${label} menu must link to #/settings`);
    assert.ok(html.includes('id="profile-lang-theme-row"'), `${label} menu must include Language & Theme row`);
    assert.equal(hasCardNestedMenuGroup(html), false, `${label} must not nest .sw-menu-group inside .card`);
    assert.equal((html.match(/class="sw-menu-row"/g) || []).length, 4, `${label} menu card must have exactly 4 rows`);
    assert.equal(countPrimaryButtons(html), 1, `${label} must have exactly 1 btn-primary`);
  }

  // 4. /proof 凭证详情页：清除 12H 冲价雷达盘（renderCorridorRadar），改为 1 行指向 #/round 轻链接
  for (const [label, html] of [['live proof', liveZh.pages.proof], ['demo proof', demoZh.pages.proof]]) {
    assert.ok(!html.includes('corridor-radar') && !html.includes('radar-dual-counts'), `${label} must not embed 12H corridor radar`);
    assert.ok(html.includes('id="proof-round-progress-link"') && html.includes('href="#/round"'), `${label} must include lightweight #/round link`);
  }

  // 5. /rules：22 条错误码收进默认折叠的 <details id="rules-section-matrix">
  assert.match(liveZh.pages.rules, /<details[^>]*id="rules-section-matrix"(?![^>]*\bopen\b)/, '22 error codes must be collapsed by default inside /rules');
  assert.ok(liveZh.pages.rules_matrix.includes('ERR_0x1301_TON_REJECTED') && liveZh.pages.rules_matrix.includes('ERR_0x5522_API_MAINTENANCE'));

  // 6. 顶栏 ... 菜单仅留 3 项（主题 / 语言 / 规则与透明）
  const appSrc = readFileSync(join(JS_DIR, 'app.js'), 'utf8');
  const moreFn = appSrc.slice(appSrc.indexOf('function openMoreQuickSheet()'), appSrc.indexOf('const dangerItems = config.isDemo'));
  const menuLabels = [...moreFn.matchAll(/^\s{6}label:\s*L\('([^']+)'/gm)].map((m) => m[1]);
  assert.deepEqual(menuLabels, ['主题', '语言', '规则与透明'], `top-bar more menu must keep only Theme / Language / Rules & Transparency, got: ${menuLabels}`);
});
