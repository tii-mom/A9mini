import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const JS_DIR = dirname(fileURLToPath(import.meta.url));
const JS_URL = pathToFileURL(JS_DIR).href;

/**
 * 在隔离子进程中运行带最小 DOM 桩的钱包弹层测试场景，避免污染其它测试全局态。
 */
function runWalletModalScenario({ lang = 'zh', liveFundsEnabled = false, mode = 'live', sdkMode = 'async-ok' }, scriptBody) {
  const fullLang = lang === 'en' ? 'en-US' : 'zh-CN';
  const runner = `
    const storageMap = new Map([['a9_ui_prefs_v1', JSON.stringify({ settings: { language: ${JSON.stringify(fullLang)} } })]]);
    const appendedScripts = [];
    let lastModalHtml = '';
    const elements = new Map();

    const makeEl = (id = '') => ({
      id,
      dataset: {},
      style: {},
      disabled: false,
      textContent: '',
      _html: '',
      get innerHTML() { return this._html; },
      set innerHTML(v) { this._html = String(v); lastModalHtml = this._html; },
      get outerHTML() { return this._html; },
      set outerHTML(v) { this._html = String(v); lastModalHtml = this._html; },
      classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
      setAttribute() {},
      removeAttribute() {},
      addEventListener() {},
      focus() {},
      querySelector() { return null; },
      querySelectorAll() { return []; },
      remove() {},
    });

    const modalRoot = makeEl('modal-root');
    const toastRoot = makeEl('toast-root');
    elements.set('modal-root', modalRoot);
    elements.set('toast-root', toastRoot);

    globalThis.localStorage = {
      getItem: (k) => (storageMap.has(k) ? storageMap.get(k) : null),
      setItem: (k, v) => storageMap.set(k, String(v)),
      removeItem: (k) => storageMap.delete(k),
    };
    globalThis.sessionStorage = { getItem: () => null, setItem() {}, removeItem() {} };
    Object.defineProperty(globalThis, 'navigator', {
      value: { language: ${JSON.stringify(lang === 'en' ? 'en-US' : 'zh-CN')}, clipboard: { writeText: async () => {} } },
      configurable: true,
    });
    globalThis.window = {
      __A9_CONFIG__: { mode: ${JSON.stringify(mode)}, network: 'testnet', apiBase: 'https://api.example.invalid', liveFundsEnabled: ${JSON.stringify(liveFundsEnabled)}, botHandle: 'A9_TestnetBot' },
      location: { href: 'https://app.example.invalid/?mode=' + ${JSON.stringify(mode)}, origin: 'https://app.example.invalid', search: '?mode=' + ${JSON.stringify(mode)}, hash: '#/challenge' },
      addEventListener() {},
      dispatchEvent() {},
    };
    globalThis.document = {
      documentElement: { dataset: { theme: 'light' }, lang: ${JSON.stringify(fullLang)} },
      body: { dataset: {}, classList: { add() {}, remove() {}, toggle() {} }, appendChild() {} },
      activeElement: null,
      addEventListener() {},
      removeEventListener() {},
      head: {
        appendChild(s) {
          appendedScripts.push(s);
          if (${JSON.stringify(sdkMode)} === 'async-ok') {
            setTimeout(() => {
              globalThis.window.TON_CONNECT_UI = {
                TonConnectUI: class FakeTonConnectUI {
                  constructor(opts) { this.opts = opts; this.connected = false; }
                  onStatusChange(cb) { this._cb = cb; }
                  setConnectRequestParameters() {}
                  async openModal() { globalThis.__openModalCalls = (globalThis.__openModalCalls || 0) + 1; }
                  async disconnect() {}
                },
              };
              s.onload?.();
            }, 15);
          } else if (${JSON.stringify(sdkMode)} === 'async-fail') {
            setTimeout(() => { s.onerror?.(); }, 15);
          }
        },
      },
      createElement(tag) { return makeEl(tag); },
      getElementById(id) {
        if (id === 'modal-root') return modalRoot;
        if (id === 'toast-root') return toastRoot;
        if (id === 'tc-wallet-sheet') {
          const m = lastModalHtml.match(/data-modal-seq="(\\d+)"/);
          if (!m) return null;
          const el = makeEl('tc-wallet-sheet');
          el.dataset.modalSeq = m[1];
          return el;
        }
        if (lastModalHtml.includes('id="' + id + '"')) {
          if (!elements.has(id)) elements.set(id, makeEl(id));
          return elements.get(id);
        }
        return null;
      },
      querySelector() { return null; },
      querySelectorAll() { return []; },
    };

    const JS_URL = ${JSON.stringify(JS_URL)};
    const getLastModalHtml = () => lastModalHtml;
    const getScriptCount = () => appendedScripts.length;
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    ${scriptBody}
  `;
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', runner], { encoding: 'utf8' });
  const line = out.trim().split('\n').at(-1);
  return JSON.parse(line);
}

test('P2: 源码与弹层彻底移除工程状态字，保留签名门禁与 SRI 校验', () => {
  const src = readFileSync(join(JS_DIR, 'tonconnect.js'), 'utf8');
  for (const forbidden of ['SDK NOT READY', 'DISCONNECTED', 'CONNECTION STATUS', 'OWNERSHIP PROOF', 'SANDBOX READY', 'SDK v2 LIVE']) {
    assert.ok(!src.includes(forbidden), `tonconnect.js must not contain engineering label: ${forbidden}`);
  }
  assert.match(src, /assertWalletReadyForLiveTx\(\)/);
  assert.match(src, /script\.integrity = 'sha384-ej0rYqvkb978ljOWDi1iAt5spb5B7sRdf1g8Hii30vS72XLjxoCPCmx5seE7s05g'/);
});

test('P2: 打开弹层瞬间开始按需加载 SDK（加载中→连接钱包），中文含 4 条安全说明与只读灰字', () => {
  const res = runWalletModalScenario({ lang: 'zh', sdkMode: 'async-ok' }, `
    const { tonConnect } = await import(JS_URL + '/tonconnect.js');
    // 首屏调用 restoreOnStartup 无会话时绝不预载 SDK
    tonConnect.restoreOnStartup(() => {});
    const scriptsBeforeOpen = getScriptCount();

    // 打开弹层瞬间触发按需加载
    tonConnect.openConnectModal(() => {});
    const scriptsOnOpen = getScriptCount();
    const loadingHtml = getLastModalHtml();

    await wait(50);
    const readyHtml = getLastModalHtml();
    console.log(JSON.stringify({ scriptsBeforeOpen, scriptsOnOpen, loadingHtml, readyHtml }));
  `);

  assert.equal(res.scriptsBeforeOpen, 0, 'plain startup must not preload SDK');
  assert.equal(res.scriptsOnOpen, 1, 'opening wallet modal must immediately trigger SDK load');
  assert.ok(res.loadingHtml.includes('正在加载钱包…'), 'loading state must show user-friendly Chinese copy');
  assert.ok(res.loadingHtml.includes('tc-btn-spinner'), 'loading button must include inline spinner');
  assert.ok(res.readyHtml.includes('连接钱包'), 'ready state must show Connect Wallet button');
  // 4 条中文安全说明 + 只读底部灰字
  assert.ok(res.readyHtml.includes('不会获取你的私钥'));
  assert.ok(res.readyHtml.includes('连接时可能请求验证钱包归属'));
  assert.ok(res.readyHtml.includes('连接和验签本身不扣费'));
  assert.ok(res.readyHtml.includes('每笔交易都需你在钱包中确认'));
  assert.ok(res.readyHtml.includes('tc-readonly-note'));
  assert.ok(res.readyHtml.includes('只读模式'));
  // 单屏 btn-primary <= 1
  const primaryCount = (res.readyHtml.match(/btn btn-primary/g) || []).length;
  assert.ok(primaryCount <= 1, `expected <= 1 btn-primary, got ${primaryCount}`);
});

test('P2: SDK 加载失败时展示「连接失败，重试」且英文双语文案完整无工程词', () => {
  const res = runWalletModalScenario({ lang: 'en', sdkMode: 'async-fail' }, `
    const { tonConnect } = await import(JS_URL + '/tonconnect.js');
    tonConnect.openConnectModal(() => {});
    const loadingHtml = getLastModalHtml();
    await wait(50);
    const failedHtml = getLastModalHtml();
    console.log(JSON.stringify({ loadingHtml, failedHtml }));
  `);

  assert.ok(res.loadingHtml.includes('Loading wallet…'));
  assert.ok(res.failedHtml.includes('Connection failed, retry'));
  assert.ok(res.failedHtml.includes('Never accesses your private key'));
  assert.ok(res.failedHtml.includes('verify wallet ownership'));
  assert.ok(res.failedHtml.includes('zero fees'));
  assert.ok(res.failedHtml.includes('confirmation in your wallet'));
  assert.ok(res.failedHtml.includes('Read-only mode'));
  for (const forbidden of ['SDK', 'DISCONNECTED', 'STATUS']) {
    assert.ok(!res.failedHtml.includes(forbidden), `English modal must not leak ${forbidden}`);
  }
});

test('P2: 已连接态展示短地址 + 复制 + 断开，且主按钮不超过 1 个', () => {
  const res = runWalletModalScenario({ lang: 'zh', sdkMode: 'async-ok' }, `
    const { store } = await import(JS_URL + '/store.js');
    const { tonConnect } = await import(JS_URL + '/tonconnect.js');
    store.update((s) => {
      s.user.connected = true;
      s.user.address = '0:' + '11'.repeat(32);
      s.user.shortAddress = 'kQARER...ERER';
      s.user.walletChain = '-3';
      s.user.walletVerificationState = 'fresh_proof';
    });
    tonConnect.sdkReady = true;
    tonConnect.openConnectModal(() => {});
    const html = getLastModalHtml();
    console.log(JSON.stringify({ html }));
  `);

  assert.ok(res.html.includes('kQARER...ERER'), 'connected view must show short address');
  assert.ok(res.html.includes('id="tc-copy-wallet"') && res.html.includes('复制'));
  assert.ok(res.html.includes('id="tc-disconnect"') && res.html.includes('断开'));
  assert.ok(res.html.includes('已验证归属'));
  assert.equal((res.html.match(/btn btn-primary/g) || []).length, 0, 'connected modal should not render competing primary CTA');
});
