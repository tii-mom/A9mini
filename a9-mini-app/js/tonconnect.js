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
import { buildV15StakeTx, buildV15ClaimTx, buildV15PromoFeeTx, buildV15PresaleTx, parseTonAddress } from './v15-tx.js';
import { A9TMA as TMA } from './tma.js';
import { fetchMe, requestTonProofPayload, submitTonProof } from './data.js';

/** 真实模式且在 Telegram 内：钱包归属需通过 ton_proof 由服务端验证。 */
const proofFlowEnabled = () => !config.isDemo && Boolean(TMA.getRawInitData());
/** 真实模式且生产配置已显式开启实盘资金总闸。 */
const liveFundsReady = () => !config.isDemo && config.liveFundsEnabled === true;

function canonicalWalletKey(addr) {
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

  init() {
    try {
      const globalSDK = window.TON_CONNECT_UI;
      if (globalSDK && globalSDK.TonConnectUI) {
        const manifestUrl = new URL('/tonconnect-manifest.json', window.location.origin).href;
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
              s.user.walletVerificationState = 'unverified';
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
              s.user.walletVerificationState = 'unverified';
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
      this.lastError = e?.message || '获取钱包归属挑战失败';
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
      if (proof && 'error' in proof) {
        const reason = proof.error?.message || proof.error?.code || '钱包未提供归属签名';
        showToast(`钱包未完成归属签名：${reason}`, 'amber');
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
        if (res?.status === 'PENDING_REBIND') {
          pending = true;
          showToast(`换绑申请已提交，将于 ${new Date(res.wallet.pendingSwitch.effectiveAt * 1000).toLocaleString()} 生效；原钱包可签名取消`, 'amber');
        } else if (res?.status === 'UNBOUND') {
          showToast('已通过原钱包签名解除钱包绑定', 'amber');
        } else if (res?.status === 'REBIND_CANCELLED') {
          showToast('已取消待生效的钱包换绑申请');
        }
      } else {
        // 恢复的本地钱包连接没有本次 ton_proof：不标为本次已重新验证，仅核对服务端既有绑定。
        const me = await fetchMe();
        pendingSwitch = me?.wallet?.pendingSwitch || null;
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
      });
      if (verificationState === 'restored_binding') {
        showToast('已恢复连接（沿用服务端历史绑定，本次未重新签名验证）', 'amber');
      } else if (!freshVerified && !pending && !(proof && 'error' in proof)) {
        showToast('钱包尚未完成归属验证，请断开后重新连接并签名', 'amber');
      }
    } catch (e) {
      store.update(s => {
        s.user.walletVerified = false;
        s.user.walletVerificationState = 'unverified';
      });
      showToast(`钱包归属验证失败：${e?.message || '请重试'}`, 'error');
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
        ? '<span class="chip chip-green">本次已验签</span>'
        : user.walletVerificationState === 'restored_binding'
          ? '<span class="chip chip-amber">历史绑定 · 本次未重验</span>'
          : '<span class="chip chip-red">未验证归属</span>';

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
        ${!canSandbox && user.connected ? `<div class="row-between" style="margin-top:6px;"><span class="caps text-muted">OWNERSHIP PROOF</span>${verifyChip}</div>` : ''}
        <div class="num-sm text-cyan" style="margin-top:6px;word-break:break-all;">${user.connected ? escapeHtml(user.address) : '尚未连接非托管 TON 钱包'}</div>
        ${!canSandbox && user.pendingSwitch ? `<div class="num-xs text-gold" style="margin-top:6px;">待生效换绑：将于 ${new Date(Number(user.pendingSwitch.effectiveAt) * 1000).toLocaleString()} 生效；可使用原钱包重签取消。</div>` : ''}
        ${!this.sdkReady ? `<div class="num-xs text-muted" style="margin-top:6px;">${escapeHtml(this.lastError || 'SDK 未就绪')}</div>` : ''}
        ${canSandbox
          ? `<div class="num-xs text-gold" style="margin-top:6px;">当前为演示模式：沙盒连接与资金结果均由本地演示数据生成，不会触发真实钱包签名。</div>`
          : liveFundsReady()
            ? `<div class="num-xs text-green" style="margin-top:6px;">当前为真实交易模式：支持连接钱包与按授权发起非托管 TON Connect 2.0 链上交易签名。</div>`
            : `<div class="num-xs text-muted" style="margin-top:6px;">当前为真实只读模式：仅支持连接钱包与只读数据查看，不会发起任何资金交易签名。</div>`}
      </div>
      ${!this.sdkReady && !canSandbox ? `
        <div class="card row-between" style="border-color:var(--gold-border);">
          <span class="num-xs text-sec">${icon('shieldAlert', 13, 'text-gold')} 钱包组件未就绪，无法连接或签名。</span>
        </div>
      ` : ''}
      <div class="col-gap">
        <button class="btn btn-primary" id="tc-real-connect">${icon('bolt', 16)} ${this.sdkReady ? '唤起 TON Connect 2.0 官方钱包列表' : (canSandbox ? '连接非托管 TON 钱包 (模拟)' : '重试加载钱包 SDK')}</button>
        ${!canSandbox && this.sdkReady && user.pendingSwitch ? `<button class="btn btn-secondary" id="tc-cancel-rebind">${icon('shieldCheck', 15)} 原钱包重签取消换绑</button>` : ''}
        ${!canSandbox && this.sdkReady && user.connected ? `<button class="btn btn-secondary" id="tc-unbind-wallet">${icon('shieldAlert', 15)} 签名解除服务端绑定</button>` : ''}
        ${user.connected ? `<button class="btn btn-danger" id="tc-disconnect">${icon('x', 16)} 断开当前钱包连接</button>` : ''}
        <button class="btn btn-secondary" id="tc-close">关闭</button>
      </div>
    `);

    document.getElementById('tc-close').onclick = closeModal;

    const launchWithProof = async (purpose = 'bind') => {
      closeModal();
      if (this.sdkReady && this.ui) {
        try {
          if (proofFlowEnabled()) {
            if (purpose !== 'bind' && this.ui.connected) {
              try { await this.ui.disconnect(); } catch (_) {}
            }
            const ready = await this._ensureFreshProofPayload(purpose);
            if (!ready) {
              showToast('获取钱包签名挑战失败，请检查网络后重试', 'error');
              return;
            }
          }
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
        showToast('已断开 TON 钱包连接', 'amber');
        if (onChanged) onChanged();
      };
    }
  }

  /**
   * 统一钱包交易发送入口（硬约束）：
   * - demo 模式：无论真实钱包是否已连接，仅由 demo-data.js 生成模拟回执，绝不弹出真实钱包签名。
   * - live 只读态（liveFundsEnabled=false）：一律抛出 LIVE_FUNDS_DISABLED，绝不调用 ui.sendTransaction。
   * - live 实盘态（liveFundsEnabled=true）：核验 SDK 与已连钱包后调用 TON Connect 2.0 sendTransaction。
   */
  async _dispatch(tx, action = 'demo_tx') {
    if (config.isDemo) {
      return demoWalletSendResult(action);
    }
    if (!liveFundsReady()) {
      throw createFundsDisabledError();
    }
    if (!this.sdkReady || !this.ui || typeof this.ui.sendTransaction !== 'function') {
      const err = new Error('TON Connect SDK 尚未就绪，请先刷新或重试加载钱包组件');
      err.code = 'WALLET_SDK_NOT_READY';
      throw err;
    }
    if (!store.state.user.connected) {
      const err = new Error('请先连接非托管 TON 钱包后再发起交易签名');
      err.code = 'WALLET_NOT_CONNECTED';
      throw err;
    }
    try {
      const res = await this.ui.sendTransaction(tx);
      return {
        simulated: false,
        boc: res?.boc || null,
        action,
      };
    } catch (e) {
      const msg = String(e?.message || e || '');
      const rejected = /reject|cancel|declin|user/i.test(msg);
      const err = new Error(rejected ? '已在钱包中取消本次签名，未扣款' : (msg || '钱包交易签名失败，请重试'));
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

  /** v15/v16 质押 A9 Jetton（demo 返回模拟回执；live 仅在 liveFundsEnabled=true 时真实签名）。 */
  async sendV15StakeA9({ userJettonWallet, roundController, userAddress, amountA9Raw, roundId, queryId = BigInt(Date.now()), protocolVersion = null }) {
    if (!config.isDemo && !liveFundsReady()) throw createFundsDisabledError();
    if (!userJettonWallet || !roundController || !userAddress) {
      const err = new Error('缺少 A9 钱包或 RoundController 地址，无法构造质押交易');
      err.code = 'STAKE_PARAMS_MISSING';
      throw err;
    }
    const serverCfg = store.state.round?.protocolConfig || {};
    const resolvedVersion = protocolVersion
      || serverCfg.stakeProtocolVersion
      || (serverCfg.protocolVersion === 'v16' ? 'v16' : config.stakeProtocolVersion);
    return await this._dispatch(buildV15StakeTx({
      userJettonWallet, roundController, userAddress, amountA9Raw, roundId, queryId,
      protocolVersion: resolvedVersion,
    }), 'demo_v15_stake');
  }

  /** v15/v16 领取本金 + 已解锁奖励（StakeTicket TicketClaim，附 0.22 GRAM Gas）。 */
  async sendV15TicketClaim(ticketAddress, queryId = BigInt(Date.now())) {
    if (!config.isDemo && !liveFundsReady()) throw createFundsDisabledError();
    const target = ticketAddress || (config.isDemo ? 'EQD_DEMO_TICKET' : '');
    if (!target) {
      const err = new Error('缺少 StakeTicket 凭证地址，无法发起领奖');
      err.code = 'TICKET_ADDRESS_MISSING';
      throw err;
    }
    return await this._dispatch(buildV15ClaimTx(target, queryId), 'demo_v15_claim');
  }

  /** v15/v16 邀友奖励 0.06 GRAM 手续费转账（触发推广热钱包自动发 A9）。 */
  async sendV15PromoFee(intent) {
    if (!config.isDemo && !liveFundsReady()) throw createFundsDisabledError();
    if (!intent?.payTo || !intent?.memo) {
      const err = new Error('邀友奖励支付单无效，请重新获取');
      err.code = 'BAD_PROMO_INTENT';
      throw err;
    }
    return await this._dispatch(buildV15PromoFeeTx(intent), 'demo_v15_promo');
  }

  /** v15/v16 宝箱商城 / A9 固定兑换 GRAM 支付（memo = buy:<orderId>）。 */
  async sendV15PresaleTx(order) {
    if (!config.isDemo && !liveFundsReady()) throw createFundsDisabledError();
    if (!order?.payTo || !order?.memo || !order?.tonNano) {
      const err = new Error('宝箱商城付款单无效，请重新下单');
      err.code = 'BAD_PRESALE_ORDER';
      throw err;
    }
    return await this._dispatch(buildV15PresaleTx({
      payTo: order.payTo,
      tonNano: order.tonNano,
      memo: order.memo,
    }), 'demo_v15_presale');
  }
}

export const tonConnect = new A9TonConnect();
