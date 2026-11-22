/**
 * TON Connect 2.0 接入层
 *
 * 真实模式：SDK / manifest 缺失时给出明确提示与重试入口，绝不伪造钱包或交易结果。
 * 演示模式：保留原有沙盒回退（模拟地址、模拟广播结果），并在界面明确标识为 DEMO。
 * 合约版本交付前，真实模式不开放任何资金写入。
 */

import { store } from './store.js';
import { config } from './config.js';
import { demoWalletSendResult } from './demo-data.js';
import { A9Haptic } from './tma.js';
import { escapeHtml, showToast, openModal, closeModal } from './components.js';
import { icon } from './icons.js';
import { buildV15StakeTx, buildV15ClaimTx, buildV15PromoFeeTx } from './v15-tx.js';
import { A9TMA as TMA } from './tma.js';
import { fetchMe, requestTonProofPayload, submitTonProof } from './data.js';

/** 真实模式且在 Telegram 内：钱包归属需通过 ton_proof 由服务端验证。 */
const proofFlowEnabled = () => !config.isDemo && Boolean(TMA.getRawInitData());

export const LIVE_READONLY_REASON = '当前真实模式处于只读验收阶段，资金交易与钱包签名入口暂未开放（支持连接钱包与只读查询）。';

function createFundsDisabledError(reason = LIVE_READONLY_REASON) {
  const err = new Error(reason);
  err.code = 'LIVE_FUNDS_DISABLED';
  return err;
}

class A9TonConnect {
  constructor() {
    this.ui = null;
    this.sdkReady = false;
    this.lastError = null;
    this._onChanged = null;
  }

  syncTheme(mode) {
    if (!this.ui) return;
    try {
      this.ui.uiOptions = { uiPreferences: { theme: mode === 'dark' ? 'DARK' : 'LIGHT' } };
    } catch (_) {}
  }

  init() {
    try {
      const globalSDK = window.TON_CONNECT_UI;
      if (globalSDK && globalSDK.TonConnectUI) {
        const manifestUrl = new URL('./tonconnect-manifest.json', window.location.href).href;
        const isDark = document.documentElement.dataset.theme === 'dark';
        this.ui = new globalSDK.TonConnectUI({
          manifestUrl,
          uiPreferences: { theme: isDark ? 'DARK' : 'LIGHT' }
        });
        this.sdkReady = true;

        this.ui.onStatusChange(async (wallet) => {
          if (wallet?.account?.address) {
            const addr = wallet.account.address;
            const short = `${addr.slice(0, 4)}...${addr.slice(-4)}`;
            store.update(s => {
              s.user.connected = true;
              s.user.address = addr;
              s.user.shortAddress = short;
              s.user.walletVerified = false;
            });
            showToast(`TON Connect 2.0 已连接: ${short}`);
            await this._verifyOwnership(wallet);
          } else {
            // 仅断开本地连接；服务端的长期钱包绑定保持不变（解除绑定需当前钱包签名）。
            store.update(s => {
              s.user.connected = false;
              s.user.address = null;
              s.user.shortAddress = null;
              s.user.walletVerified = false;
            });
          }
          if (this._onChanged) this._onChanged();
        });
        this._prepareProofPayload();
      } else {
        this.lastError = 'TON Connect SDK 未加载（检查网络或 CDN）';
      }
    } catch (e) {
      this.sdkReady = false;
      this.lastError = e?.message || 'TON Connect 初始化失败';
    }
  }

  /** 预取一次性 ton_proof 载荷，下次连接钱包时随连接请求一起签名。 */
  async _prepareProofPayload() {
    if (!this.ui || !proofFlowEnabled() || typeof this.ui.setConnectRequestParameters !== 'function') return;
    try {
      this.ui.setConnectRequestParameters({ state: 'loading' });
      const { payload } = await requestTonProofPayload();
      this.ui.setConnectRequestParameters({ state: 'ready', value: { tonProof: payload } });
    } catch (_) {
      this.ui.setConnectRequestParameters(null);
    }
  }

  /**
   * 钱包归属验证：新连接提交 ton_proof；恢复的旧连接只认可服务端已有的同一钱包绑定。
   * 验证失败时保持“已连接但未验证”，不得访问任何私有资产。
   */
  async _verifyOwnership(wallet) {
    if (!proofFlowEnabled()) return;
    const proof = wallet?.connectItems?.tonProof;
    try {
      let verified = false;
      let pending = false;
      if (proof && 'proof' in proof) {
        const res = await submitTonProof({
          address: wallet.account.address,
          network: wallet.account.chain,
          publicKey: wallet.account.publicKey,
          walletStateInit: wallet.account.walletStateInit,
          proof: proof.proof,
        });
        verified = res?.status === 'BOUND' || res?.status === 'UNCHANGED';
        if (res?.status === 'PENDING_REBIND') {
          pending = true;
          showToast(`换绑申请已提交，将于 ${new Date(res.wallet.pendingSwitch.effectiveAt * 1000).toLocaleString()} 生效；原钱包可签名取消`, 'amber');
        }
      } else {
        const me = await fetchMe();
        verified = Boolean(me?.wallet?.address) && String(me.wallet.address) === String(wallet.account.address);
      }
      store.update(s => { s.user.walletVerified = verified; });
      if (!verified && !pending) showToast('钱包尚未完成归属验证，请断开后重新连接', 'amber');
    } catch (e) {
      store.update(s => { s.user.walletVerified = false; });
      showToast(`钱包归属验证失败：${e?.message || '请重试'}`, 'error');
    } finally {
      this._prepareProofPayload();
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

    openModal(`
      <div class="sheet-handle"></div>
      <div class="row-between">
        <div class="card-title">${icon('wallet', 18, 'text-green')} TON Connect 2.0 钱包终端</div>
        <span class="chip ${this.sdkReady ? 'chip-green' : (canSandbox ? 'chip-cyan' : 'chip-red')}">${this.modeLabel}</span>
      </div>
      <div class="sub-tile">
        <div class="row-between">
          <span class="caps text-muted">CONNECTION STATUS</span>
          <span class="chip ${user.connected ? 'chip-green' : 'chip-amber'}">${user.connected ? 'CONNECTED' : 'DISCONNECTED'}</span>
        </div>
        <div class="num-sm text-cyan" style="margin-top:6px;word-break:break-all;">${user.connected ? escapeHtml(user.address) : '尚未连接非托管 TON 钱包'}</div>
        ${!this.sdkReady ? `<div class="num-xs text-muted" style="margin-top:6px;">${escapeHtml(this.lastError || 'SDK 未就绪')}</div>` : ''}
        ${canSandbox ? `<div class="num-xs text-gold" style="margin-top:6px;">当前为演示模式：沙盒连接与资金结果均由本地演示数据生成，不会触发真实钱包签名。</div>` : `<div class="num-xs text-muted" style="margin-top:6px;">当前为真实只读模式：仅支持连接钱包与只读数据查看，不会发起任何资金交易签名。</div>`}
      </div>
      ${!this.sdkReady && !canSandbox ? `
        <div class="card row-between" style="border-color:var(--gold-border);">
          <span class="num-xs text-sec">${icon('shieldAlert', 13, 'text-gold')} 钱包组件未就绪，无法连接或签名。</span>
        </div>
      ` : ''}
      <div class="col-gap">
        <button class="btn btn-primary" id="tc-real-connect">${icon('bolt', 16)} ${this.sdkReady ? '唤起 TON Connect 2.0 官方钱包列表' : (canSandbox ? '连接非托管 TON 钱包 (模拟)' : '重试加载钱包 SDK')}</button>
        ${user.connected ? `<button class="btn btn-danger" id="tc-disconnect">${icon('x', 16)} 断开当前钱包连接</button>` : ''}
        <button class="btn btn-secondary" id="tc-close">关闭</button>
      </div>
    `);

    document.getElementById('tc-close').onclick = closeModal;

    document.getElementById('tc-real-connect').onclick = async () => {
      closeModal();
      if (this.sdkReady && this.ui) {
        try {
          await this.ui.openModal();
          return;
        } catch (e) {
          this.lastError = e?.message || '钱包连接失败';
          showToast('钱包连接失败，请重试', 'error');
          return;
        }
      }
      if (!canSandbox) {
        this.init();
        showToast(this.sdkReady ? '钱包 SDK 已就绪，请重试' : '钱包 SDK 仍不可用，请检查网络后重试', 'error');
        return;
      }
      A9Haptic.success();
      store.update(s => {
        s.user.connected = true;
        s.user.address = 'UQ_9921_A9_TERMINAL_489f';
        s.user.shortAddress = 'UQ...489f';
      });
      showToast('[演示模式] 已接入模拟钱包 UQ...489f');
      if (onChanged) onChanged();
    };

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
        });
        showToast('已断开 TON 钱包连接', 'amber');
        if (onChanged) onChanged();
      };
    }
  }

  /**
   * 统一钱包交易发送入口（硬约束）：
   * - live 模式：严格只读，无论钱包是否已连接一律抛出 LIVE_FUNDS_DISABLED，绝不调用 ui.sendTransaction。
   * - demo 模式：无论真实钱包是否已连接，仅由 demo-data.js 生成模拟回执，绝不弹出真实钱包签名。
   */
  async _dispatch(tx, action = 'demo_tx') {
    if (!config.isDemo) {
      throw createFundsDisabledError();
    }
    return demoWalletSendResult(action);
  }

  /** 质押入口（live 模式强制禁用；demo 模式仅返回模拟回执）。 */
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

  /** v15 质押 A9（live 模式强制禁用；demo 模式仅返回模拟回执）。 */
  async sendV15StakeA9({ userJettonWallet, roundController, userAddress, amountA9Raw, roundId, queryId = BigInt(Date.now()) }) {
    if (!config.isDemo) throw createFundsDisabledError();
    if (!userJettonWallet || !roundController || !userAddress) {
      const err = new Error('缺少 A9 钱包或 RoundController 地址，无法构造质押交易');
      err.code = 'STAKE_PARAMS_MISSING';
      throw err;
    }
    return await this._dispatch(buildV15StakeTx({ userJettonWallet, roundController, userAddress, amountA9Raw, roundId, queryId }), 'demo_v15_stake');
  }

  /** v15 领取本金 + 已解锁奖励（live 模式强制禁用；demo 模式仅返回模拟回执）。 */
  async sendV15TicketClaim(ticketAddress, queryId = BigInt(Date.now())) {
    if (!config.isDemo) throw createFundsDisabledError();
    const target = ticketAddress || 'EQD_DEMO_TICKET';
    return await this._dispatch(buildV15ClaimTx(target, queryId), 'demo_v15_claim');
  }

  /** v15 推广奖励领取（live 模式强制禁用；demo 模式仅返回模拟回执）。 */
  async sendV15PromoFee(intent) {
    if (!config.isDemo) throw createFundsDisabledError();
    if (!intent?.payTo || !intent?.memo) {
      const err = new Error('推广奖励支付单无效，请重新获取');
      err.code = 'BAD_PROMO_INTENT';
      throw err;
    }
    return await this._dispatch(buildV15PromoFeeTx(intent), 'demo_v15_promo');
  }
}

export const tonConnect = new A9TonConnect();
