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
import { buildV15StakeTx, buildV15ClaimTx, buildV17EarlyExitTx, buildV15PromoFeeTx, buildV15PresaleTx, parseTonAddress } from './v15-tx.js';
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

export const LIVE_READONLY_REASON = '当前真实模式处于只读验收阶段，资金交易与钱包签名入口暂未开放（支持连接钱包与只读查询）。';

function getLiveReadonlyReason() {
  return L(
    LIVE_READONLY_REASON,
    'Live mode is currently read-only; wallet connection and queries work, while on-chain fund signing is disabled.'
  );
}

function createFundsDisabledError(reason = null) {
  const err = new Error(reason || getLiveReadonlyReason());
  err.code = 'LIVE_FUNDS_DISABLED';
  return err;
}

class A9TonConnect {
  constructor() {
    this.ui = null;
    this.sdkReady = false;
    this.lastError = null;
    this._onChanged = null;
    this._proofPayload = null;
    this._proofExpiresAtSec = 0;
    this._proofPurpose = 'bind';
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
    if (expectedChain && walletChain && walletChain !== expectedChain) {
      const wantLabel = expectedChain === '-239' ? L('TON 主网 (-239)', 'TON Mainnet (-239)') : L('TON 测试网 (-3)', 'TON Testnet (-3)');
      const err = new Error(L(`当前钱包网络 (${walletChain}) 与协议网络不匹配，请切换至 ${wantLabel} 后重试`, `Wallet network (${walletChain}) mismatches protocol; switch to ${wantLabel} and retry`));
      err.code = 'WRONG_WALLET_NETWORK';
      throw err;
    }
    if (proofFlowEnabled()) {
      if (u.walletVerificationState === 'unverified') {
        const err = new Error(L('当前钱包尚未完成 Telegram 归属签名校验，请断开后重连钱包完成验签', 'Wallet ownership proof not verified; disconnect and reconnect to sign'));
        err.code = 'WALLET_NOT_VERIFIED';
        throw err;
      }
      if (u.serverBoundWallet && canonicalWalletKey(u.address) !== canonicalWalletKey(u.serverBoundWallet)) {
        const err = new Error(L('当前连接的钱包与账号已绑定钱包不一致，已拦截签名以防资金错付', 'Connected wallet differs from your bound account wallet; signing blocked for safety'));
        err.code = 'WALLET_MISMATCH';
        throw err;
      }
    }
    return true;
  }

  async ensureSdk() {
    if (config.isDemo || this.sdkReady) return;
    if (!window.TON_CONNECT_UI?.TonConnectUI) {
      this.sdkLoad ||= new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = './js/vendor/tonconnect-ui.min.js';
        script.integrity = 'sha384-ej0rYqvkb978ljOWDi1iAt5spb5B7sRdf1g8Hii30vS72XLjxoCPCmx5seE7s05g';
        script.crossOrigin = 'anonymous';
        script.onload = resolve;
        script.onerror = () => { script.remove(); reject(new Error('Wallet SDK unavailable')); };
        document.head.appendChild(script);
      });
      try { await this.sdkLoad; }
      catch (error) { this.sdkLoad = null; this.lastError = error.message; return; }
    }
    if (!this.sdkReady) this.init();
  }

  restoreOnStartup(onChanged) {
    this._onChanged = onChanged || null;
    if (config.isDemo) return;
    if (window.TON_CONNECT_UI?.TonConnectUI) { this.init(); return; }
    let session = false;
    try { session = Boolean(localStorage.getItem('ton-connect-storage_bridge-connection')); } catch {}
    const startParam = window.Telegram?.WebApp?.initDataUnsafe?.start_param || new URLSearchParams(window.location.search).get('startapp');
    if (session || /^(?:tonconnect|tc_ret)(?:_|$)/i.test(startParam || '') || /[?&#](?:tonconnect|tc|tc_ret|ret|tonConnectReturn)(?:=|&|$)/i.test(window.location.href)) {
      void this.ensureSdk();
    }
  }

  init() {
    try {
      const globalSDK = window.TON_CONNECT_UI;
      if (globalSDK && globalSDK.TonConnectUI) {
        const manifestUrl = new URL('/tonconnect-manifest.json', window.location.origin).href;
        const isDark = document.documentElement.dataset.theme === 'dark';
        const botHandle = String(window.__A9_CONFIG__?.botHandle || 'A9_TonBot').replace(/^@/, '').trim() || 'A9_TonBot';
        this.ui = new globalSDK.TonConnectUI({
          manifestUrl,
          uiPreferences: { theme: isDark ? 'DARK' : 'LIGHT' },
          actionsConfiguration: { twaReturnUrl: `https://t.me/${botHandle}` },
        });
        this.sdkReady = true;

        this.ui.onStatusChange(async (wallet) => {
          if (wallet?.account?.address) {
            const addr = wallet.account.address;
            const chain = wallet.account.chain ? String(wallet.account.chain) : null;
            const short = `${addr.slice(0, 4)}...${addr.slice(-4)}`;
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
              showToast(L(`TON Connect 2.0 已连接: ${short}`, `TON Connect 2.0 connected: ${short}`));
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
        this.lastError = L('TON Connect SDK 未加载（检查网络或 CDN）', 'TON Connect SDK not loaded (check network)');
      }
    } catch (e) {
      this.sdkReady = false;
      this.lastError = e?.message || L('TON Connect 初始化失败', 'TON Connect initialization failed');
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

  get modeLabel() {
    if (this.sdkReady) return 'SDK v2 LIVE';
    return config.isDemo ? 'SANDBOX READY' : 'SDK NOT READY';
  }

  openConnectModal(onChanged) {
    A9Haptic.light();
    this._onChanged = onChanged || null;
    const { user } = store.state;
    const canSandbox = config.isDemo;

    const verifyChip = !user.connected
      ? ''
      : user.walletVerificationState === 'fresh_proof'
        ? `<span class="chip chip-green">${L('本次已验签', 'Proof Verified')}</span>`
        : user.walletVerificationState === 'restored_binding'
          ? `<span class="chip chip-amber">${L('历史绑定 · 本次未重验', 'Restored Binding')}</span>`
          : `<span class="chip chip-red">${L('未验证归属', 'Unverified')}</span>`;

    openModal(`
      <div class="sheet-handle"></div>
      <div class="row-between">
        <div class="card-title">${icon('wallet', 18, 'text-green')} ${L('TON Connect 2.0 钱包终端', 'TON Connect 2.0 Wallet')}</div>
        <span class="chip ${this.sdkReady ? 'chip-green' : (canSandbox ? 'chip-cyan' : 'chip-red')}">${this.modeLabel}</span>
      </div>
      <div class="sub-tile">
        <div class="row-between">
          <span class="caps text-muted">CONNECTION STATUS</span>
          <span class="chip ${user.connected ? 'chip-green' : 'chip-amber'}">${user.connected ? 'CONNECTED' : 'DISCONNECTED'}</span>
        </div>
        ${!canSandbox && user.connected ? `<div class="row-between" style="margin-top:6px;"><span class="caps text-muted">OWNERSHIP PROOF</span>${verifyChip}</div>` : ''}
        <div class="row-between" style="margin-top:6px;gap:8px;">
          <div class="num-sm text-cyan" style="word-break:break-all;">${user.connected ? escapeHtml(user.address) : L('尚未连接非托管 TON 钱包', 'No non-custodial TON wallet connected')}</div>
          ${user.connected ? `<button class="pill-trigger neutral" id="tc-copy-wallet" type="button" style="flex-shrink:0;">${icon('copy', 11)} ${L('复制', 'Copy')}</button>` : ''}
        </div>
        ${!canSandbox && user.pendingSwitch ? `<div class="num-xs text-gold" style="margin-top:6px;">${L(`待生效换绑：将于 ${new Date(Number(user.pendingSwitch.effectiveAt) * 1000).toLocaleString()} 生效；可使用原钱包重签取消。`, `Pending rebind effective at ${new Date(Number(user.pendingSwitch.effectiveAt) * 1000).toLocaleString()}; re-sign with original wallet to cancel.`)}</div>` : ''}
        ${!this.sdkReady ? `<div class="num-xs text-muted" style="margin-top:6px;">${escapeHtml(this.lastError || L('连接时加载钱包', 'Wallet loads on connect'))}</div>` : ''}
        ${canSandbox
          ? `<div class="num-xs text-gold" style="margin-top:6px;">${L('当前为演示模式：沙盒连接与资金结果均由本地演示数据生成，不会触发真实钱包签名。', 'Demo mode: sandbox wallet and results are simulated locally with no real signatures.')}</div>`
          : liveFundsReady()
            ? `<div class="num-xs text-green" style="margin-top:6px;">${L('当前为真实交易模式：支持连接钱包与按授权发起非托管 TON Connect 2.0 链上交易签名。', 'Live mode: supports non-custodial TON Connect 2.0 wallet connection and authorized on-chain signing.')}</div>`
            : `<div class="num-xs text-muted" style="margin-top:6px;">${L('当前为真实只读模式：仅支持连接钱包与只读数据查看，不会发起任何资金交易签名。', 'Live read-only mode: wallet connection and read-only queries only; fund signing is disabled.')}</div>`}
      </div>
      ${!this.sdkReady && !canSandbox && this.lastError ? `
        <div class="card row-between" style="border-color:var(--gold-border);">
          <span class="num-xs text-sec">${icon('shieldAlert', 13, 'text-gold')} ${L('钱包组件未就绪，无法连接或签名。', 'Wallet SDK unavailable; cannot connect or sign.')}</span>
        </div>
      ` : ''}
      <div class="col-gap">
        <button class="btn btn-primary" id="tc-real-connect">${icon('bolt', 16)} ${this.sdkReady ? L('唤起 TON Connect 2.0 官方钱包列表', 'Open TON Connect 2.0 Wallet List') : (canSandbox ? L('连接非托管 TON 钱包 (模拟)', 'Connect TON Wallet (Demo)') : L('连接钱包', 'Connect wallet'))}</button>
        ${!canSandbox && this.sdkReady && user.pendingSwitch ? `<button class="btn btn-secondary" id="tc-cancel-rebind">${icon('shieldCheck', 15)} ${L('原钱包重签取消换绑', 'Cancel Rebind (Original Wallet)')}</button>` : ''}
        ${!canSandbox && this.sdkReady && user.connected ? `<button class="btn btn-secondary" id="tc-unbind-wallet">${icon('shieldAlert', 15)} ${L('签名解除服务端绑定', 'Sign to Unbind Wallet')}</button>` : ''}
        ${user.connected ? `<button class="btn btn-danger" id="tc-disconnect">${icon('x', 16)} ${L('断开当前钱包连接', 'Disconnect Wallet')}</button>` : ''}
        <button class="btn btn-secondary" id="tc-close">${L('关闭', 'Close')}</button>
      </div>
    `);

    document.getElementById('tc-close').onclick = () => { A9Haptic.light(); closeModal(); };
    const copyWalletBtn = document.getElementById('tc-copy-wallet');
    if (copyWalletBtn && user.address) {
      copyWalletBtn.onclick = () => copyText(user.address, L('已复制钱包地址', 'Wallet address copied'));
    }

    const launchWithProof = async (purpose = 'bind') => {
      closeModal();
      if (!canSandbox) await this.ensureSdk();
      if (this.sdkReady && this.ui) {
        try {
          if (proofFlowEnabled()) {
            if (purpose !== 'bind' && this.ui.connected) {
              try { await this.ui.disconnect(); } catch (_) {}
            }
            const ready = await this._ensureFreshProofPayload(purpose);
            if (!ready) {
              showToast(L('获取钱包签名挑战失败，请检查网络后重试', 'Failed to get proof challenge; check network and retry'), 'error');
              return;
            }
          }
          await this.ui.openModal();
          return;
        } catch (e) {
          this.lastError = e?.message || L('钱包连接失败', 'Wallet connection failed');
          showToast(L('钱包连接失败，请重试', 'Wallet connection failed; please retry'), 'error');
          return;
        }
      }
      if (!canSandbox) {
        this.init();
        showToast(this.sdkReady ? L('钱包 SDK 已就绪，请重试', 'Wallet SDK ready; please retry') : L('钱包 SDK 仍不可用，请检查网络后重试', 'Wallet SDK still unavailable; check network'), 'error');
        return;
      }
      A9Haptic.success();
      store.update(s => {
        s.user.connected = true;
        s.user.address = 'UQ_9921_A9_TERMINAL_489f';
        s.user.shortAddress = 'UQ...489f';
      });
      showToast(L('[演示模式] 已接入模拟钱包 UQ...489f', '[Demo] Connected simulated wallet UQ...489f'));
      if (onChanged) onChanged();
    };

    document.getElementById('tc-real-connect').onclick = () => launchWithProof('bind');
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
          s.user.walletVerified = false;
          s.user.walletVerificationState = 'unverified';
        });
        showToast(L('已断开 TON 钱包连接', 'TON wallet disconnected'), 'amber');
        if (onChanged) onChanged();
      };
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
      const rejected = /reject|cancel|declin|user/i.test(msg);
      const err = new Error(rejected ? L('已在钱包中取消本次签名，未扣款', 'Signature cancelled in wallet; no funds spent') : (msg || L('钱包交易签名失败，请重试', 'Wallet signing failed; please retry')));
      err.code = rejected ? 'USER_REJECTED' : (e?.code || 'WALLET_TX_FAILED');
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
