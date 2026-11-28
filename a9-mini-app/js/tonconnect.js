/**
 * TON Connect 2.0 接入层
 *
 * 真实模式：SDK / manifest 缺失时给出明确提示与重试入口，绝不伪造钱包或交易结果。
 * 演示模式：保留原有沙盒回退（模拟地址、模拟广播结果），并在界面明确标识为 DEMO。
 * 合约版本交付前，真实模式不开放任何资金写入。
 */

import { store } from './store.js';
import { config } from './config.js';
import { loadDemoModule } from './demo-loader.js';
import { A9Haptic } from './tma.js';
import { escapeHtml, showToast, copyText, openModal, closeModal } from './components.js';
import { icon } from './icons.js';
import { L } from './i18n.js';
import { buildV15StakeTx, buildV15ClaimTx, buildV17EarlyExitTx, buildV15PromoFeeTx, buildV15PresaleTx, parseTonAddress, formatTonAddress } from './v15-tx.js';
import { A9TMA as TMA } from './tma.js';
import { fetchMe, requestTonProofPayload, submitTonProof } from './data.js';
import { openTxRiskConfirmModal } from './tx-ux.js';

/** 真实模式且在 Telegram 内：钱包归属需通过 ton_proof 由服务端验证。 */
const proofFlowEnabled = () => !config.isDemo && Boolean(TMA.getRawInitData());
/** 真实模式且生产配置已显式开启实盘资金总闸。 */
const liveFundsReady = () => !config.isDemo && config.liveFundsEnabled === true;

export function canonicalWalletKey(addr) {
  const s = String(addr || '').trim();
  if (!s) return '';
  try {
    const p = parseTonAddress(s);
    const hex = Array.from(p.hash, (b) => b.toString(16).padStart(2, '0')).join('');
    return `${p.workchain}:${hex}`;
  } catch (_) {
    return s;
  }
}

export function walletDisplayAddress(address, chain) {
  if (!address) return '';
  // Use the wallet's actual network; unknown or invalid inputs stay unchanged.
  if (chain !== '-3' && chain !== '-239') return String(address);
  try { return formatTonAddress(address, { testnet: chain === '-3' }); }
  catch { return String(address); }
}

export const LIVE_READONLY_REASON = '当前真实模式处于只读验收阶段，资金交易与钱包签名入口暂未开放（支持连接钱包与只读查询）。';

function getLiveReadonlyReason() {
  return L(
    LIVE_READONLY_REASON,
    'Live mode is currently read-only; wallet connection and queries work, while on-chain fund signing is disabled.'
  );
}

const PRODUCTION_BOT_HANDLE = 'A9_TonBot';

/** 归一化 Telegram Bot 句柄；非法输入返回空串。 */
function normalizeBotHandle(raw) {
  const s = String(raw || '').replace(/^@+/, '').trim();
  return /^[A-Za-z0-9_]{5,64}$/.test(s) ? s : '';
}

function isProductionBotHandle(raw) {
  return normalizeBotHandle(raw).toLowerCase() === PRODUCTION_BOT_HANDLE.toLowerCase();
}

/**
 * 钱包回跳（twaReturnUrl）使用的 Bot 句柄：
 * - 依次尝试受信任部署配置注入的句柄、服务端 /api/config 下发的句柄；
 * - 测试网一律拒绝归一化后大小写不敏感的正式 Bot 句柄（无论来自注入还是服务端），
 *   也不允许在缺少有效句柄时回落到正式 Bot；主网保留既有默认行为。
 */
function resolveReturnBotHandle() {
  const sources = [
    window.__A9_CONFIG__?.botHandle || window.__A9_CONFIG__?.tgBotHandle,
    store.state.round?.protocolConfig?.botHandle || store.state.round?.protocolConfig?.tgBotHandle,
  ];
  for (const source of sources) {
    const handle = normalizeBotHandle(source);
    if (!handle) continue;
    if (config.network === 'testnet' && isProductionBotHandle(handle)) continue;
    return handle;
  }
  return config.network === 'testnet' ? '' : PRODUCTION_BOT_HANDLE;
}

/**
 * 钱包确认后的回跳入口：
 * - 必须带 startapp=tonconnect 才会打开 Bot 的 Main Mini App；裸 https://t.me/<bot>
 *   只会落回 Bot 聊天页（真机验收 F-01）。
 * - 返回 null 表示当前网络没有可信入口（测试网缺句柄 / 句柄非法），调用方必须显式失败，
 *   绝不静默回落到正式 Bot。
 */
function resolveReturnEntry() {
  const handle = resolveReturnBotHandle();
  if (!handle) return null;
  return { handle, url: `https://t.me/${handle}?startapp=tonconnect` };
}

/** 钱包 App 回跳时 Telegram 透传的 start_param：保留旧有裸 tonconnect，兼容 tonconnect-… / tonconnect_… / tc_ret。 */
const RETURN_START_PARAM_RE = /^(?:tonconnect(?:[-_]|$)|tc_ret(?:_|$))/i;

function createFundsDisabledError(reason = null) {
  const err = new Error(reason || getLiveReadonlyReason());
  err.code = 'LIVE_FUNDS_DISABLED';
  return err;
}

class A9TonConnect {
  constructor() {
    this.ui = null;
    this.sdkReady = false;
    this.sdkLoading = false;
    this.lastError = null;
    this._onChanged = null;
    this._proofPayload = null;
    this._proofExpiresAtSec = 0;
    this._proofPurpose = 'bind';
    this.returnEntry = null;
    this.returnEntryError = null;
    this._modalSeq = 0;
  }

  syncTheme(mode) {
    if (!this.ui) return;
    try {
      this.ui.uiOptions = { uiPreferences: { theme: mode === 'dark' ? 'DARK' : 'LIGHT' } };
    } catch (_) {}
  }

  getExpectedNetwork() {
    const raw = String(store.state.round?.protocolConfig?.network || config.network || '').trim().toLowerCase();
    if (raw === 'mainnet' || raw === 'testnet') return raw;
    return null;
  }

  getExpectedChainId() {
    const net = this.getExpectedNetwork();
    if (net === 'mainnet') return '-239';
    if (net === 'testnet') return '-3';
    return null;
  }

  /**
   * 钱包确认回跳入口守卫：测试网缺句柄/句柄非法时阻断唤起钱包，
   * 避免确认后落在 Bot 聊天页或误入正式 Bot。
   */
  assertReturnEntryReady() {
    if (config.isDemo || this.returnEntry) return true;
    const err = new Error(L('测试网钱包回跳入口未配置：请为测试 Bot 配置 Main Mini App 或注入有效 botHandle 后重试', 'Testnet wallet return entry is not configured; configure the test bot Main Mini App or inject a valid botHandle and retry'));
    err.code = 'WALLET_RETURN_ENTRY_MISSING';
    throw err;
  }

  /**
   * 实盘签名前前置守卫：校验实盘总闸、连接态、钱包网络（防错链签名）以及 Telegram 内归属验签与绑定一致性。
   */
  assertWalletReadyForLiveTx() {
    if (config.isDemo) return true;
    if (!liveFundsReady()) {
      throw createFundsDisabledError();
    }
    if (!this.sdkReady || !this.ui || typeof this.ui.sendTransaction !== 'function') {
      const err = new Error(L('TON Connect SDK 尚未就绪，请先刷新或重试加载钱包组件', 'TON Connect SDK is not ready; please refresh and retry'));
      err.code = 'WALLET_SDK_NOT_READY';
      throw err;
    }
    const u = store.state.user;
    if (!u.connected || !u.address) {
      const err = new Error(L('请先连接非托管 TON 钱包后再发起交易签名', 'Please connect a non-custodial TON wallet before signing'));
      err.code = 'WALLET_NOT_CONNECTED';
      throw err;
    }
    const expectedChain = this.getExpectedChainId();
    const walletChain = String(this.ui?.wallet?.account?.chain || u.walletChain || '').trim();
    if (!expectedChain || !walletChain || walletChain !== expectedChain) {
      const wantLabel = expectedChain === '-239'
        ? L('TON 主网 (-239)', 'TON Mainnet (-239)')
        : expectedChain === '-3'
          ? L('TON 测试网 (-3)', 'TON Testnet (-3)')
          : L('已配置协议网络', 'configured protocol network');
      const gotLabel = walletChain || L('未知网络', 'unknown');
      const err = new Error(L(`当前钱包网络 (${gotLabel}) 与协议网络不匹配，请切换至 ${wantLabel} 后重试`, `Wallet network (${gotLabel}) mismatches protocol; switch to ${wantLabel} and retry`));
      err.code = 'WRONG_WALLET_NETWORK';
      throw err;
    }
    const tonProofStatus = u.walletVerificationState;
    if (!TMA.getRawInitData() || (tonProofStatus !== 'fresh_proof' && tonProofStatus !== 'restored_binding')) {
      const err = new Error(L('当前钱包尚未在 Telegram 小程序内完成归属签名校验，请断开后重连钱包完成验签', 'Wallet ownership proof not verified inside Telegram Mini App; disconnect and reconnect to sign'));
      err.code = 'WALLET_NOT_VERIFIED';
      throw err;
    }
    if (u.serverBoundWallet && canonicalWalletKey(u.address) !== canonicalWalletKey(u.serverBoundWallet)) {
      const err = new Error(L('当前连接的钱包与账号已绑定钱包不一致，已拦截签名以防资金错付', 'Connected wallet differs from your bound account wallet; signing blocked for safety'));
      err.code = 'WALLET_MISMATCH';
      throw err;
    }
    return true;
  }

  async ensureSdk() {
    if (config.isDemo || this.sdkReady) return;
    this.sdkLoading = true;
    try {
      if (!window.TON_CONNECT_UI?.TonConnectUI) {
        if (!this.sdkLoad) this.lastError = null;
        this.sdkLoad ||= new Promise((resolve, reject) => {
          const script = document.createElement('script');
          script.src = './js/vendor/tonconnect-ui.min.js';
          script.integrity = 'sha384-ej0rYqvkb978ljOWDi1iAt5spb5B7sRdf1g8Hii30vS72XLjxoCPCmx5seE7s05g';
          script.crossOrigin = 'anonymous';
          script.onload = resolve;
          script.onerror = () => { script.remove(); reject(new Error(L('钱包组件加载失败，请检查网络后重试', 'Failed to load wallet component; check network and retry'))); };
          document.head.appendChild(script);
        });
        try { await this.sdkLoad; }
        catch (error) { this.sdkLoad = null; this.lastError = error.message; return; }
      }
      if (!this.sdkReady) this.init();
    } finally {
      this.sdkLoading = false;
    }
  }

  restoreOnStartup(onChanged) {
    this._onChanged = onChanged || null;
    if (config.isDemo) return;
    if (window.TON_CONNECT_UI?.TonConnectUI) { this.init(); return; }
    let session = false;
    try { session = Boolean(localStorage.getItem('ton-connect-storage_bridge-connection')); } catch {}
    const startParam = window.Telegram?.WebApp?.initDataUnsafe?.start_param || new URLSearchParams(window.location.search).get('startapp');
    if (
      session ||
      RETURN_START_PARAM_RE.test(startParam || '') ||
      /[?&#](?:tgWebAppStartParam=)?(?:tonconnect|tc|tc_ret|ret|tonConnectReturn)(?:[-_=]|&|$)/i.test(window.location.href)
    ) {
      void this.ensureSdk();
    }
  }

  init() {
    try {
      const globalSDK = window.TON_CONNECT_UI;
      if (globalSDK && globalSDK.TonConnectUI) {
        const manifestUrl = new URL('/tonconnect-manifest.json', window.location.origin).href;
        const isDark = document.documentElement.dataset.theme === 'dark';
        const returnEntry = resolveReturnEntry();
        this.returnEntry = returnEntry;
        this.returnEntryError = returnEntry ? null : 'WALLET_RETURN_ENTRY_MISSING';
        this.ui = new globalSDK.TonConnectUI({
          manifestUrl,
          uiPreferences: { theme: isDark ? 'DARK' : 'LIGHT' },
          // 无有效入口时显式 returnStrategy=none（确认后留在钱包、由用户手动返回），
          // 绝不回落到正式 Bot 或裸 Bot 聊天页。
          actionsConfiguration: returnEntry
            ? { twaReturnUrl: returnEntry.url }
            : { returnStrategy: 'none' },
        });
        this.sdkReady = true;

        this.ui.onStatusChange(async (wallet) => {
          if (wallet?.account?.address) {
            const addr = wallet.account.address;
            const chain = wallet.account.chain ? String(wallet.account.chain) : null;
            const displayAddress = walletDisplayAddress(addr, chain);
            const short = `${displayAddress.slice(0, 6)}...${displayAddress.slice(-6)}`;
            store.update(s => {
              s.user.connected = true;
              s.user.address = addr;
              s.user.shortAddress = short;
              s.user.walletChain = chain;
              s.user.walletVerified = false;
              s.user.walletVerificationState = 'unverified';
            });
            const expectedChain = this.getExpectedChainId();
            if (!config.isDemo && expectedChain && chain && chain !== expectedChain) {
              const wantLabel = expectedChain === '-239' ? L('TON 主网 (-239)', 'TON Mainnet (-239)') : L('TON 测试网 (-3)', 'TON Testnet (-3)');
              showToast(L(`检测到错链钱包 (${chain})，请切换至 ${wantLabel}`, `Wrong wallet network (${chain}); please switch to ${wantLabel}`), 'error');
            } else {
              showToast(L(`钱包已连接：${short}`, `Wallet connected: ${short}`));
            }
            await this._verifyOwnership(wallet);
          } else {
            // 仅断开本地连接；服务端的长期钱包绑定保持不变（解除绑定需当前钱包签名）。
            store.update(s => {
              s.user.connected = false;
              s.user.address = null;
              s.user.shortAddress = null;
              s.user.walletChain = null;
              s.user.serverBoundWallet = null;
              s.user.walletVerified = false;
              s.user.walletVerificationState = 'unverified';
            });
          }
          if (this._onChanged) this._onChanged();
        });
        this._prepareProofPayload();
      } else {
        this.lastError = L('钱包组件未加载，请检查网络后重试', 'Wallet component not loaded; please check network and retry');
      }
    } catch (e) {
      this.sdkReady = false;
      this.lastError = e?.message || L('钱包初始化失败，请重试', 'Wallet initialization failed; please retry');
    }
  }

  /** 预取一次性 ton_proof 载荷，并记录过期时间，避免超过 15 分钟 TTL 签出失效挑战。 */
  async _prepareProofPayload(purpose = 'bind') {
    if (!this.ui || !proofFlowEnabled() || typeof this.ui.setConnectRequestParameters !== 'function') return false;
    try {
      this._proofPurpose = purpose;
      this.ui.setConnectRequestParameters({ state: 'loading' });
      const res = await requestTonProofPayload(purpose);
      const payload = res?.payload || '';
      if (!payload) throw new Error('empty ton_proof payload');
      this._proofPayload = payload;
      this._proofExpiresAtSec = Number(res?.expiresAt || (Math.floor(Date.now() / 1000) + 900));
      this.ui.setConnectRequestParameters({ state: 'ready', value: { tonProof: payload } });
      return true;
    } catch (e) {
      this._proofPayload = null;
      this._proofExpiresAtSec = 0;
      this.lastError = e?.message || L('获取钱包归属挑战失败', 'Failed to fetch wallet proof challenge');
      this.ui.setConnectRequestParameters(null);
      return false;
    }
  }

  /** 拉起钱包连接前确保 ton_proof 挑战有效且剩余寿命 > 120s，防止过期或首次预取失败竞态。 */
  async _ensureFreshProofPayload(purpose = 'bind') {
    if (!proofFlowEnabled()) return true;
    const nowSec = Math.floor(Date.now() / 1000);
    if (this._proofPayload && this._proofPurpose === purpose && (this._proofExpiresAtSec - nowSec) > 120) {
      return true;
    }
    return this._prepareProofPayload(purpose);
  }

  /**
   * 钱包归属验证（P0-F）：
   * - 新连接携带新鲜 ton_proof：由服务端验签确认后才标记为本次已验证（fresh_proof）；
   * - 恢复旧钱包连接（无本次 ton_proof）：绝不凭前端缓存宣称本次所有权已重新验证！
   *   仅向服务端 /api/me 核对是否存在同一钱包的历史绑定（restored_binding），否则保持 unverified 并提示重新签名。
   */
  async _verifyOwnership(wallet) {
    if (!proofFlowEnabled()) return;
    const proof = wallet?.connectItems?.tonProof;
    try {
      let freshVerified = false;
      let verificationState = 'unverified';
      let pending = false;
      let pendingSwitch = null;
      let serverBoundWallet = null;
      if (proof && 'error' in proof) {
        const reason = proof.error?.message || proof.error?.code || L('钱包未提供归属签名', 'Wallet did not return ownership proof');
        showToast(L(`钱包未完成归属签名：${reason}`, `Ownership proof incomplete: ${reason}`), 'amber');
      } else if (proof && 'proof' in proof) {
        const res = await submitTonProof({
          address: wallet.account.address,
          network: wallet.account.chain,
          publicKey: wallet.account.publicKey,
          walletStateInit: wallet.account.walletStateInit,
          proof: proof.proof,
          purpose: this._proofPurpose || 'bind',
        });
        freshVerified = res?.status === 'BOUND' || res?.status === 'UNCHANGED' || res?.status === 'REBIND_CANCELLED';
        if (freshVerified) verificationState = 'fresh_proof';
        pendingSwitch = res?.wallet?.pendingSwitch || null;
        serverBoundWallet = res?.wallet?.address || null;
        if (res?.status === 'PENDING_REBIND') {
          pending = true;
          const effTime = new Date(res.wallet.pendingSwitch.effectiveAt * 1000).toLocaleString();
          showToast(L(`换绑申请已提交，将于 ${effTime} 生效；原钱包可签名取消`, `Rebind requested; effective at ${effTime}. Sign with original wallet to cancel`), 'amber');
        } else if (res?.status === 'UNBOUND') {
          showToast(L('已通过原钱包签名解除钱包绑定', 'Wallet unbound via original wallet signature'), 'amber');
        } else if (res?.status === 'REBIND_CANCELLED') {
          showToast(L('已取消待生效的钱包换绑申请', 'Pending wallet rebind cancelled'));
        }
      } else {
        // 恢复的本地钱包连接没有本次 ton_proof：不标为本次已重新验证，仅核对服务端既有绑定。
        const me = await fetchMe();
        pendingSwitch = me?.wallet?.pendingSwitch || null;
        serverBoundWallet = me?.wallet?.address || null;
        const boundKey = me?.wallet?.walletKey || canonicalWalletKey(me?.wallet?.address);
        const restoredKey = canonicalWalletKey(wallet.account.address);
        if (boundKey && restoredKey && boundKey === restoredKey) {
          verificationState = 'restored_binding';
        }
      }
      store.update(s => {
        s.user.walletVerified = freshVerified;
        s.user.walletVerificationState = verificationState;
        s.user.pendingSwitch = pendingSwitch;
        s.user.serverBoundWallet = serverBoundWallet;
      });
      if (verificationState === 'restored_binding') {
        showToast(L('已恢复连接（沿用服务端历史绑定，本次未重新签名验证）', 'Session restored (reusing server binding; no fresh proof this session)'), 'amber');
      } else if (!freshVerified && !pending && !(proof && 'error' in proof)) {
        showToast(L('钱包尚未完成归属验证，请断开后重新连接并签名', 'Wallet ownership not verified; disconnect and reconnect to sign'), 'amber');
      }
    } catch (e) {
      store.update(s => {
        s.user.walletVerified = false;
        s.user.walletVerificationState = 'unverified';
      });
      showToast(L(`钱包归属验证失败：${e?.message || '请重试'}`, `Wallet verification failed: ${e?.message || 'please retry'}`), 'error');
    } finally {
      this._proofPayload = null;
      this._proofExpiresAtSec = 0;
      this._prepareProofPayload('bind');
    }
  }

  /**
   * 构造用户语言钱包弹层内容（零工程状态字，中英双语安全说明，只读提示降级为底部一行灰字）。
   * 打开弹层瞬间即按需加载钱包组件，绝不在普通首屏统一预载。
   */
  openConnectModal(onChanged) {
    A9Haptic.light();
    this._onChanged = onChanged || null;
    const seq = ++this._modalSeq;
    const canSandbox = config.isDemo;

    const getShortAddress = (displayAddr, fallbackShort) => {
      if (fallbackShort) return fallbackShort;
      if (!displayAddr) return '—';
      if (displayAddr.length <= 16) return displayAddr;
      return `${displayAddr.slice(0, 6)}...${displayAddr.slice(-6)}`;
    };

    const renderSheet = (stateOverride = null) => {
      const { user } = store.state;
      const displayAddress = walletDisplayAddress(user.address, user.walletChain);
      const shortAddress = getShortAddress(displayAddress, user.shortAddress);
      const networkLabel = user.walletChain === '-3'
        ? L('TON 测试网', 'TON Testnet')
        : user.walletChain === '-239'
          ? L('TON 主网', 'TON Mainnet')
          : L('网络待确认', 'Network pending');

      const isConnected = Boolean(user.connected && user.address);
      const isLoading = stateOverride === 'loading' || (!canSandbox && !isConnected && this.sdkLoading);
      const hasFailed = stateOverride === 'failed' || (!canSandbox && !isConnected && !isLoading && Boolean(this.lastError));

      const verifyChip = !isConnected
        ? ''
        : user.walletVerificationState === 'fresh_proof'
          ? `<span class="chip chip-green">${L('已验证归属', 'Verified')}</span>`
          : user.walletVerificationState === 'restored_binding'
            ? `<span class="chip chip-amber">${L('历史绑定', 'Restored')}</span>`
            : `<span class="chip chip-red">${L('待验证归属', 'Unverified')}</span>`;

      const safetyItems = [
        L('不会获取你的私钥或助记词', 'Never accesses your private key or recovery phrase'),
        L('连接时可能请求验证钱包归属', 'May request a signature to verify wallet ownership'),
        L('连接和验签本身不扣费', 'Connecting and verifying ownership cost zero fees'),
        L('每笔交易都需你在钱包中确认', 'Every transaction requires your confirmation in your wallet'),
      ];

      const primaryBtnHtml = isConnected
        ? ''
        : isLoading
          ? `<button class="btn btn-primary" id="tc-real-connect" type="button" disabled aria-busy="true"><span class="tc-btn-spinner" aria-hidden="true"></span> ${L('正在加载钱包…', 'Loading wallet…')}</button>`
          : hasFailed
            ? `<button class="btn btn-primary" id="tc-real-connect" type="button">${icon('refresh', 15)} ${L('连接失败，重试', 'Connection failed, retry')}</button>`
            : `<button class="btn btn-primary" id="tc-real-connect" type="button">${icon('wallet', 16)} ${canSandbox ? L('连接钱包（演示）', 'Connect Wallet (Demo)') : L('连接钱包', 'Connect Wallet')}</button>`;

      const footerNote = canSandbox
        ? L('演示模式：本地模拟钱包连接，不会触发真实链上交易。', 'Demo mode: simulated local wallet; no real on-chain transactions.')
        : liveFundsReady()
          ? L('当前支持连接钱包与按授权确认链上交易。', 'Wallet connection and authorized on-chain confirmations enabled.')
          : L('当前为只读模式：仅支持连接钱包与数据查询，暂不开放资金交易。', 'Read-only mode: wallet connection and queries only; fund signing is disabled.');

      const html = `
        <div id="tc-wallet-sheet" data-modal-seq="${seq}" class="col-gap" style="gap:10px;">
          <div class="sheet-handle"></div>
          <div class="row-between">
            <div class="card-title">${icon('wallet', 18, 'text-red')} ${isConnected ? L('我的钱包', 'My Wallet') : L('连接钱包', 'Connect Wallet')}</div>
            ${!canSandbox && isConnected ? verifyChip : ''}
          </div>

          ${isConnected ? `
            <div class="sub-tile col-gap" style="gap:8px;">
              <div class="tc-connected-row">
                <div style="min-width:0;">
                  <div class="num-md mono" style="font-weight:800;white-space:nowrap;">${escapeHtml(shortAddress)}</div>
                  ${!canSandbox ? `<div class="num-xs text-muted" style="margin-top:2px;">${escapeHtml(networkLabel)}</div>` : ''}
                </div>
                <div class="tc-connected-actions">
                  <button class="pill-trigger neutral" id="tc-copy-wallet" type="button">${icon('copy', 12)} ${L('复制', 'Copy')}</button>
                  <button class="pill-trigger neutral" id="tc-disconnect" type="button" style="color:var(--red);">${icon('x', 12)} ${L('断开', 'Disconnect')}</button>
                </div>
              </div>
              ${!canSandbox && user.pendingSwitch ? `<div class="num-xs text-gold">${L(`待生效换绑：将于 ${new Date(Number(user.pendingSwitch.effectiveAt) * 1000).toLocaleString()} 生效；可使用原钱包重签取消。`, `Pending rebind effective at ${new Date(Number(user.pendingSwitch.effectiveAt) * 1000).toLocaleString()}; re-sign with original wallet to cancel.`)}</div>` : ''}
            </div>
          ` : `
            <div class="sub-tile col-gap" style="gap:4px;">
              <div class="num-sm" style="font-weight:700;color:var(--ink);">
                ${isLoading
                  ? L('正在准备非托管 TON 钱包组件…', 'Preparing non-custodial TON wallet…')
                  : hasFailed
                    ? L('暂时无法连接钱包，请检查网络后重试', 'Unable to connect right now; check network and retry')
                    : L('使用你的非托管 TON 钱包连接 A9', 'Connect your non-custodial TON wallet to A9')}
              </div>
              ${hasFailed && this.lastError ? `<div class="num-xs text-muted">${escapeHtml(this.lastError)}</div>` : ''}
            </div>
          `}

          <ul class="tc-safety-list" aria-label="${L('钱包安全说明', 'Wallet safety notes')}">
            ${safetyItems.map((line) => `<li>${icon('shieldCheck', 14, 'text-green')}<span>${escapeHtml(line)}</span></li>`).join('')}
          </ul>

          <div class="col-gap" style="gap:8px;">
            ${primaryBtnHtml}
            ${isConnected ? `<button class="btn btn-secondary" id="tc-switch-wallet" type="button">${icon('refresh', 15)} ${L('更换钱包', 'Switch Wallet')}</button>` : ''}
            ${!canSandbox && this.sdkReady && user.pendingSwitch ? `<button class="btn btn-secondary" id="tc-cancel-rebind" type="button">${icon('shieldCheck', 15)} ${L('原钱包重签取消换绑', 'Cancel Rebind (Original Wallet)')}</button>` : ''}
            ${!canSandbox && this.sdkReady && isConnected ? `<button class="btn btn-secondary" id="tc-unbind-wallet" type="button">${icon('shieldAlert', 15)} ${L('解除服务端绑定', 'Unbind Wallet')}</button>` : ''}
            <button class="btn btn-secondary" id="tc-close" type="button">${L('关闭', 'Close')}</button>
          </div>

          <p class="tc-readonly-note">${escapeHtml(footerNote)}</p>
        </div>
      `;

      const existingSheet = document.getElementById('tc-wallet-sheet');
      if (existingSheet && Number(existingSheet.dataset.modalSeq) === seq) {
        existingSheet.outerHTML = html.trim();
      } else {
        openModal(html);
      }
      bindEvents();
    };

    const isStillOpen = () => {
      const el = document.getElementById('tc-wallet-sheet');
      return Boolean(el && Number(el.dataset.modalSeq) === seq);
    };

    const launchWithProof = async (purpose = 'bind') => {
      if (canSandbox) {
        closeModal();
        A9Haptic.success();
        store.update(s => {
          s.user.connected = true;
          s.user.address = 'UQ_9921_A9_TERMINAL_489f';
          s.user.shortAddress = 'UQ...489f';
        });
        showToast(L('[演示模式] 已连接模拟钱包 UQ...489f', '[Demo] Connected simulated wallet UQ...489f'));
        if (onChanged) onChanged();
        return;
      }

      if (!this.sdkReady || !this.ui) {
        this.lastError = null;
        if (isStillOpen()) renderSheet('loading');
        await this.ensureSdk();
        if (!this.sdkReady || !this.ui) {
          this.lastError = this.lastError || L('钱包组件暂不可用，请检查网络后重试', 'Wallet component unavailable; check network and retry');
          if (isStillOpen()) renderSheet('failed');
          else showToast(L('连接失败，请重试', 'Connection failed; please retry'), 'error');
          return;
        }
      }

      try {
        this.assertReturnEntryReady();
      } catch (e) {
        this.lastError = e?.message || L('钱包回跳入口未配置', 'Wallet return entry is not configured');
        if (isStillOpen()) renderSheet('failed');
        showToast(this.lastError, 'error');
        return;
      }

      try {
        if (proofFlowEnabled()) {
          if (purpose !== 'bind' && this.ui.connected) {
            try { await this.ui.disconnect(); } catch (_) {}
          }
          const ready = await this._ensureFreshProofPayload(purpose);
          if (!ready) {
            this.lastError = L('获取钱包归属验证信息失败，请重试', 'Failed to prepare ownership verification; please retry');
            if (isStillOpen()) renderSheet('failed');
            showToast(this.lastError, 'error');
            return;
          }
        }
        this.lastError = null;
        closeModal();
        await this.ui.openModal();
      } catch (e) {
        this.lastError = e?.message || L('钱包连接已取消或失败，请重试', 'Wallet connection cancelled or failed; please retry');
        renderSheet('failed');
      }
    };

    const bindEvents = () => {
      const closeBtn = document.getElementById('tc-close');
      if (closeBtn) closeBtn.onclick = () => { A9Haptic.light(); closeModal(); };

      const copyWalletBtn = document.getElementById('tc-copy-wallet');
      if (copyWalletBtn && store.state.user.address) {
        const displayAddr = walletDisplayAddress(store.state.user.address, store.state.user.walletChain);
        copyWalletBtn.onclick = () => copyText(displayAddr, L('已复制钱包地址', 'Wallet address copied'));
      }

      const connectBtn = document.getElementById('tc-real-connect');
      if (connectBtn && !connectBtn.disabled) connectBtn.onclick = () => launchWithProof('bind');

      const switchBtn = document.getElementById('tc-switch-wallet');
      if (switchBtn) switchBtn.onclick = () => launchWithProof('bind');

      const cancelRebindBtn = document.getElementById('tc-cancel-rebind');
      if (cancelRebindBtn) cancelRebindBtn.onclick = () => launchWithProof('cancel_rebind');

      const unbindBtn = document.getElementById('tc-unbind-wallet');
      if (unbindBtn) unbindBtn.onclick = () => launchWithProof('unbind');

      const discBtn = document.getElementById('tc-disconnect');
      if (discBtn) {
        discBtn.onclick = async () => {
          closeModal();
          if (this.sdkReady && this.ui) {
            try { await this.ui.disconnect(); } catch (_) {}
          }
          A9Haptic.warning();
          store.update(s => {
            s.user.connected = false;
            s.user.address = null;
            s.user.shortAddress = null;
            s.user.walletChain = null;
            s.user.walletVerified = false;
            s.user.walletVerificationState = 'unverified';
          });
          showToast(L('已断开钱包连接', 'Wallet disconnected'), 'amber');
          if (onChanged) onChanged();
        };
      }
    };

    // 打开弹层瞬间启动按需加载（首屏绝不提前预载）
    if (!canSandbox && !this.sdkReady) {
      this.lastError = null;
      renderSheet('loading');
      void this.ensureSdk().then(() => {
        if (!isStillOpen()) return;
        renderSheet(this.sdkReady ? 'ready' : 'failed');
      });
    } else {
      renderSheet('ready');
    }
  }

  /** 统一签名前透明化风控确认卡（自动读取当前协议网络并交由 openTxRiskConfirmModal 呈现）。 */
  async confirmBeforeSign(spec = {}) {
    const network = spec.network || store.state.round?.protocolConfig?.network || config.network || 'mainnet';
    return openTxRiskConfirmModal({ ...spec, network });
  }

  /**
   * 统一钱包交易发送入口（硬约束）：
   * - demo 模式：无论真实钱包是否已连接，仅由 demo-data.js 生成模拟回执，绝不弹出真实钱包签名。
   * - live 只读态（liveFundsEnabled=false）：一律抛出 LIVE_FUNDS_DISABLED，绝不调用 ui.sendTransaction。
   * - live 实盘态（liveFundsEnabled=true）：核验 SDK 与已连钱包后调用 TON Connect 2.0 sendTransaction。
   */
  async _dispatch(tx, action = 'demo_tx') {
    if (config.isDemo) {
      const demo = await loadDemoModule();
      return demo.demoWalletSendResult(action);
    }
    // 实盘签发瞬间复验总闸、SDK、网络、ton_proof 与绑定钱包一致性，消除确认卡停留期间的 TOCTOU 窗口
    this.assertWalletReadyForLiveTx();
    const expectedChain = this.getExpectedChainId();
    const fromAddr = this.ui?.wallet?.account?.address || store.state.user.address || undefined;
    const outboundTx = {
      ...tx,
      ...(expectedChain ? { network: expectedChain } : {}),
      ...(fromAddr ? { from: fromAddr } : {}),
    };
    try {
      const res = await this.ui.sendTransaction(outboundTx);
      return {
        simulated: false,
        boc: res?.boc || null,
        action,
      };
    } catch (e) {
      const msg = String(e?.message || e || '');
      const UserRejectsError = window.TON_CONNECT_UI?.UserRejectsError;
      const rejected = typeof UserRejectsError === 'function' && e instanceof UserRejectsError;
      const err = new Error(rejected ? L('已在钱包中取消本次签名，未扣款', 'Signature cancelled in wallet; no funds spent') : (msg || L('钱包交易签名失败，请重试', 'Wallet signing failed; please retry')));
      err.code = rejected ? 'USER_REJECTED' : 'WALLET_TX_FAILED';
      throw err;
    }
  }

  /** 旧版演示质押入口（仅 demo 模式允许；live 模式一律强制走 sendV15StakeA9）。 */
  async sendStakeTransaction(tonAmount, contractAddress = null, payloadBoc = null) {
    if (!config.isDemo) throw createFundsDisabledError();
    const targetAddr = contractAddress || 'EQD_DEMO_A9_POOL';
    const nano = String(Math.round(Number(tonAmount) * 1e9));
    const message = { address: targetAddr, amount: nano };
    if (payloadBoc) message.payload = payloadBoc;
    return await this._dispatch({
      validUntil: Math.floor(Date.now() / 1000) + 300,
      messages: [message]
    }, 'demo_stake');
  }

  /** v16 质押 A9 Jetton（demo 返回模拟回执；live 仅在 liveFundsEnabled=true 时真实签名）。 */
  async sendV15StakeA9({ userJettonWallet, roundController, userAddress, amountA9Raw, roundId, queryId = BigInt(Date.now()), protocolVersion = null }) {
    if (config.isDemo) return (await loadDemoModule()).demoWalletSendResult('demo_v15_stake');
    if (!liveFundsReady()) throw createFundsDisabledError();
    if (!userJettonWallet || !roundController || !userAddress) {
      const err = new Error(L('缺少 A9 钱包或 RoundController 地址，无法构造锁仓交易', 'Missing A9 wallet or RoundController address'));
      err.code = 'STAKE_PARAMS_MISSING';
      throw err;
    }
    const serverCfg = store.state.round?.protocolConfig || {};
    const resolvedVersion = protocolVersion
      || serverCfg.stakeProtocolVersion
      || serverCfg.protocolVersion
      || config.stakeProtocolVersion
      || 'v17';
    return await this._dispatch(buildV15StakeTx({
      userJettonWallet, roundController, userAddress, amountA9Raw, roundId, queryId,
      protocolVersion: resolvedVersion,
      network: this.getExpectedNetwork(),
    }), 'demo_v15_stake');
  }

  /** v17 领取本金/止损退本 + 已解锁奖励，或勾选 3 折急提（普通 0.22 GRAM / 3 折急提 0.34 GRAM，余量全退）。 */
  async sendV15TicketClaim(ticketAddress, queryId = BigInt(Date.now()), { instantDiscount = false } = {}) {
    if (config.isDemo) return (await loadDemoModule()).demoWalletSendResult(instantDiscount ? 'demo_v17_instant_cashout' : 'demo_v15_claim');
    if (!liveFundsReady()) throw createFundsDisabledError();
    const target = ticketAddress || '';
    if (!target) {
      const err = new Error(L('缺少 StakeTicket 凭证地址，无法发起领奖', 'Missing StakeTicket address'));
      err.code = 'TICKET_ADDRESS_MISSING';
      throw err;
    }
    return await this._dispatch(
      buildV15ClaimTx(target, queryId, { network: this.getExpectedNetwork(), instantDiscount: Boolean(instantDiscount) }),
      instantDiscount ? 'demo_v17_instant_cashout' : 'demo_v15_claim',
    );
  }

  /** v17 24H 锁仓期提前解押（退 85% 本金 / 扣 15% 销毁，附 0.34 GRAM Gas，余量全退；12H 冲价期合约自动禁止）。 */
  async sendV17TicketEarlyExit(ticketAddress, queryId = BigInt(Date.now())) {
    if (config.isDemo) return (await loadDemoModule()).demoWalletSendResult('demo_v17_early_exit');
    if (!liveFundsReady()) throw createFundsDisabledError();
    const target = ticketAddress || '';
    if (!target) {
      const err = new Error(L('缺少 StakeTicket 凭证地址，无法发起提前解押', 'Missing StakeTicket address'));
      err.code = 'TICKET_ADDRESS_MISSING';
      throw err;
    }
    return await this._dispatch(
      buildV17EarlyExitTx(target, queryId, { network: this.getExpectedNetwork() }),
      'demo_v17_early_exit',
    );
  }

  /** v16 邀友奖励 0.06 GRAM 手续费转账（触发推广热钱包自动发 A9）。 */
  async sendV15PromoFee(intent) {
    if (config.isDemo) return (await loadDemoModule()).demoWalletSendResult('demo_v15_promo');
    if (!liveFundsReady()) throw createFundsDisabledError();
    if (!intent?.payTo || !intent?.memo) {
      const err = new Error(L('邀友奖励支付单无效，请重新获取', 'Invalid promo claim intent; please refresh'));
      err.code = 'BAD_PROMO_INTENT';
      throw err;
    }
    return await this._dispatch(buildV15PromoFeeTx({ ...intent, network: this.getExpectedNetwork() }), 'demo_v15_promo');
  }

  /** v16 宝箱商城 / A9 固定兑换 GRAM 支付（memo = buy:<orderId>，实付含 0.06 GRAM 发币 Gas）。 */
  async sendV15PresaleTx(order) {
    if (config.isDemo) return (await loadDemoModule()).demoWalletSendResult('demo_v15_presale');
    if (!liveFundsReady()) throw createFundsDisabledError();
    const payNano = order?.payTonNano || order?.tonNano;
    if (!order?.payTo || !order?.memo || !payNano) {
      const err = new Error(L('宝箱商城付款单无效，请重新下单', 'Invalid Chest Mall order; please create a new order'));
      err.code = 'BAD_PRESALE_ORDER';
      throw err;
    }
    return await this._dispatch(buildV15PresaleTx({
      payTo: order.payTo,
      tonNano: payNano,
      memo: order.memo,
      expiresAt: order.expiresAt || null,
      network: this.getExpectedNetwork(),
    }), 'demo_v15_presale');
  }
}

export const tonConnect = new A9TonConnect();
