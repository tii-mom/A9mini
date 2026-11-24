import { renderNintendoGateIcon } from '../paper-art.js';
/**
 * System Settings, 22-State Risk Matrix, On-Chain Audit Log & Protocol Rules Pages
 * Zero-Emoji + Real Bilingual Switcher + /rules Manual
 */

import { store } from '../store.js';
import { config } from '../config.js';
import { A9Haptic } from '../tma.js';
import { A9Audio } from '../audio.js';
import { showToast, openModal, closeModal, formatNum, copyText, escapeHtml } from '../components.js';
import { icon } from '../icons.js';
import { L, LANGUAGES } from '../i18n.js';
import { openChoiceSheet } from '../components.js';
import { tonConnect } from '../tonconnect.js';
import { renderCurrentRoute, getTheme, toggleTheme } from '../app.js';
import { PROTOCOL_SPECS, rawToA9 } from '../data.js';
import { buildTonviewerUrl, shortAddress } from '../tx-ux.js';

const RISK_STATES = [
  { id: '01', code: 'ERR_0x1301_TON_REJECTED', cat: 'wallet', titleZh: '钱包未连接 / 签名主动拒绝', titleEn: 'Wallet Not Connected / Signature Rejected', descZh: '用户在 TON Connect 2.0 握手时关闭窗口或拒绝签名。', descEn: 'User closed TON Connect 2.0 modal or rejected transaction signing.', actionZh: '快速重新连接钱包', actionEn: 'Reconnect Wallet' },
  { id: '02', code: 'ERR_0x1302_INSUFFICIENT_GAS', cat: 'wallet', titleZh: '余额不足支付 Gas / 质押本金', titleEn: 'Insufficient Gas or A9 Balance', descZh: '钱包可用 A9 不足质押下限，或 GRAM 不足覆盖 0.30 GRAM 合约调用 Gas。', descEn: 'Available A9 is below stake minimum or GRAM is insufficient for 0.30 GRAM contract gas.', actionZh: '检查钱包余额', actionEn: 'Check Wallet Balance' },
  { id: '03', code: 'ERR_0x1303_MEMPOOL_TIMEOUT', cat: 'wallet', titleZh: '链上 RPC 广播超时 / 拥堵', titleEn: 'On-Chain RPC Broadcast Timeout', descZh: 'Toncenter 节点延迟超过 8000ms，交易滞留 Mempool。', descEn: 'Toncenter RPC latency exceeded 8000ms; tx pending in mempool.', actionZh: '自动切换备用 L1 RPC', actionEn: 'Switch Fallback L1 RPC' },
  { id: '04', code: 'ERR_0x1304_BELOW_MIN_STAKE', cat: 'wallet', titleZh: '质押金额低于 1,000 A9 最小门槛', titleEn: 'Stake Below 1,000 A9 Minimum', descZh: 'v16.1 合约单次参与需确保至少 1,000 A9 完整单元。', descEn: 'v16.1 contract requires a minimum single stake of 1,000 A9.', actionZh: '一键补齐至 1,000 A9', actionEn: 'Fill to 1,000 A9' },
  { id: '05', code: 'ERR_0x1305_EXCEED_15X_HARDCAP', cat: 'wallet', titleZh: '超过 15x 单人单轮收益硬顶', titleEn: '15x Single-Round Reward Cap Reached', descZh: '复合倍率触达协议硬顶，超额部分滚存至下轮奖池。', descEn: 'Reward reached the 15x principal hard cap; excess rolls into next round.', actionZh: '查看收益上限说明', actionEn: 'View Cap Rules' },
  { id: '06', code: 'ERR_0x7E4F_QUOTA_EXHAUSTED', cat: 'quota', titleZh: '个人单轮参与额度已达上限', titleEn: 'Per-Round Personal Quota Reached', descZh: '触发防巨鲸限额保护 (Anti-Whale Guard v16.1)。', descEn: 'Triggered Anti-Whale Guard v16.1 per-round limit.', actionZh: '返回轮次闯关', actionEn: 'Back to Quest' },
  { id: '07', code: 'ERR_0x2207_STAGE_CLOSED_LOCKOUT', cat: 'quota', titleZh: '参与阶段已截单 / 进入观察期', titleEn: 'Entry Window Closed · Observing', descZh: '本轮入场通道关闭，转入连续 24 小时观察结算。', descEn: 'Round entry is closed and now in the 24H observation phase.', actionZh: '追踪当前观察仓位', actionEn: 'Track 24H Observation' },
  { id: '08', code: 'ERR_0x2208_OBSERVE_FAILED_BURN', cat: 'quota', titleZh: '24小时观察期未达标 (时段 < 16 格)', titleEn: '24H Observation Missed (< 16 Slots)', descZh: '触发 v16.1 对称销毁机制与下轮奖池结转。', descEn: 'Triggers v16.1 symmetric burn and next-round pool rollover.', actionZh: '查看清算存证哈希', actionEn: 'View Burn Proof' },
  { id: '09', code: 'ERR_0x2209_ORACLE_CIRCUIT_BREAK', cat: 'quota', titleZh: '预言机喂价异常熔断 (Pyth/RedStone)', titleEn: 'Oracle Deviation Circuit Breaker', descZh: '跨链报价偏差超阈值，系统自动开启安全隔离并 100% 退还本金。', descEn: 'Oracle price feed deviation triggered safety halt; 100% principal refunded.', actionZh: '查看熔断审计报告', actionEn: 'View Audit Report' },
  { id: '10', code: 'ERR_0x2210_NO_CLAIMABLE_BAL', cat: 'quota', titleZh: '待领取奖励为空', titleEn: 'No Claimable Rewards', descZh: '当前可提取额度为 0，其余资产仍在阶梯解锁周期中。', descEn: 'Claimable balance is 0; remaining rewards are still vesting.', actionZh: '查看解锁档位', actionEn: 'View Vesting Tiers' },
  { id: '11', code: 'ERR_0x2211_GAS_ESTIMATE_FAIL', cat: 'quota', titleZh: '智能合约领取 Gas 估算失败', titleEn: 'Claim Gas Estimation Failed', descZh: 'TVM 预执行提示 Gas 不足，建议附带 0.22 GRAM Gas（余量原路退回）。', descEn: 'TVM pre-check warned of low gas; attach 0.22 GRAM (excess refunded).', actionZh: '以 0.22 GRAM 重试', actionEn: 'Retry with 0.22 GRAM' },
  { id: '12', code: 'ERR_0x3312_TG_AUTH_REQUIRED', cat: 'market', titleZh: '未绑定 TG 账号阻断宝箱商城操作', titleEn: 'Telegram Binding Required for Chest Mall', descZh: '独立外部钱包缺少 Telegram InitData 签名校验。', descEn: 'External wallet session lacks Telegram InitData verification.', actionZh: '绑定 Telegram 账号', actionEn: 'Bind Telegram Account' },
  { id: '13', code: 'ERR_0x3313_PRESALE_SOLD_OUT', cat: 'market', titleZh: '宝箱商城当期额度已售罄 (Sold Out)', titleEn: 'Chest Mall Round Quota Sold Out', descZh: '当期宝箱库存已抢空，后发交易由系统原路免手续费退还。', descEn: 'Current chest allocation is sold out; late txs are refunded fee-free.', actionZh: '查询自动退款流水', actionEn: 'Check Refund Log' },
  { id: '14', code: 'ERR_0x3314_USER_CANCELLATION', cat: 'market', titleZh: '用户主动取消宝箱商城订单', titleEn: 'Chest Mall Order Cancelled by User', descZh: '锁仓前主动撤单，扣除固定链上计算损耗后退回余额。', descEn: 'Order cancelled before lock; balance returned minus gas overhead.', actionZh: '确认撤单规则', actionEn: 'Confirm Cancel Rules' },
  { id: '15', code: 'ERR_0x3315_DUST_NON_REFUNDABLE', cat: 'market', titleZh: '粉尘金额转账 (≤0.1 GRAM 拦截)', titleEn: 'Dust Transfer Blocked (≤ 0.1 GRAM)', descZh: '微小数额低于链上拆单成本，协议直接拦截。', descEn: 'Amount is below minimum on-chain processing threshold.', actionZh: '调整至有效档位', actionEn: 'Select Valid Tier' },
  { id: '16', code: 'ERR_0x4416_CAPTAIN_CANNOT_EXIT', cat: 'team', titleZh: '战队队长试图退队阻断', titleEn: 'Squad Captain Exit Blocked', descZh: '队长绑定分润金库，需先移交队长权限方可离队。', descEn: 'Captain is bound to squad treasury; transfer leadership before leaving.', actionZh: '前往移交队长权限', actionEn: 'Transfer Captaincy' },
  { id: '17', code: 'ERR_0x4417_TEAM_SWITCH_QUOTA', cat: 'team', titleZh: '赛季内切换战队超过 1 次限制', titleEn: 'Squad Switch Limit Exceeded', descZh: '每个赛季严格限制仅可迁移战队 1 次，防止套利。', descEn: 'Each season allows at most 1 squad transfer.', actionZh: '等待下赛季重置', actionEn: 'Wait for Next Season' },
  { id: '18', code: 'ERR_0x4418_PREHEAT_ELIGIBILITY', cat: 'team', titleZh: '开局预热未达到有效直邀门槛', titleEn: 'Pre-Round Invite Threshold Unmet', descZh: '需至少邀请 1 位完成认证的真实伙伴以激活排位资格。', descEn: 'Invite at least 1 verified friend to qualify for pre-round ranking.', actionZh: '分享专属邀请链', actionEn: 'Share Invite Link' },
  { id: '19', code: 'ERR_0x4419_INVITE_HARDCAP', cat: 'team', titleZh: '邀友奖励达 320,000 A9 单轮硬顶', titleEn: '320,000 A9 Round Invite Cap Reached', descZh: '单地址单轮邀友奖励封顶，多余积分自动转入社区奖池。', descEn: 'Single-address invite reward capped per round; excess goes to community pool.', actionZh: '查看邀友奖励上限', actionEn: 'View Invite Cap' },
  { id: '20', code: 'ERR_0x5520_TG_BOT_PERM_LOST', cat: 'sys', titleZh: 'TG 群组解绑 / Bot 管理员权限丢失', titleEn: 'TG Group Unlinked / Bot Admin Lost', descZh: '关联群组撤销了官方 Bot (@A9_TonBot) 管理员权限。', descEn: 'Linked group revoked official Bot (@A9_TonBot) admin permissions.', actionZh: '重新授权 Bot Admin', actionEn: 'Re-authorize Bot Admin' },
  { id: '21', code: 'ERR_0x5521_RENEWAL_TIMEOUT', cat: 'sys', titleZh: '连闯策略撤销超时 (<30分钟锁定)', titleEn: 'Auto-Continue Lockout (< 30 Mins)', descZh: '已进入新轮开盘前 30 分钟锁定缓冲期。', descEn: 'Locked within 30 minutes prior to the next round open.', actionZh: '等待下轮开盘后调整', actionEn: 'Adjust After Open' },
  { id: '22', code: 'ERR_0x5522_UPGRADE_PAUSED', cat: 'sys', titleZh: '智能合约升级维护公告态', titleEn: 'Contract Maintenance Window', descZh: '多签理事会正在执行 TVM 无缝升级，暂停读写 15 分钟。', descEn: 'Multisig council is performing a 15-minute TVM upgrade.', actionZh: '订阅官方升级频道', actionEn: 'Subscribe Updates' }
];

export function renderSettingsPage(root) {
  const { settings, user } = store.state;
  const curLangObj = LANGUAGES.find(l => l.code === settings.language) || LANGUAGES[0];
  const isDark = getTheme() === 'dark';
  const soundOn = A9Audio.isEnabled();

  root.innerHTML = `
    <div class="col-gap anim-page-enter">
      <div class="section-kicker">${L('外观与主题', 'APPEARANCE & THEME')}</div>
      <div class="settings-theme-grid" role="group" aria-label="${L('选择界面主题', 'Select theme')}">
        <button type="button" class="theme-preview-card ${!isDark ? 'is-active' : ''}" data-pick-theme="light" aria-pressed="${!isDark}">
          <div class="theme-swatch-screen light-swatch" aria-hidden="true">
            <div class="swatch-bar-top"><span class="swatch-dot-red"></span><span class="swatch-pill"></span></div>
            <div class="swatch-card-mini"></div>
          </div>
          <div class="theme-card-foot">
            <strong>${L('雪白亮色', 'Crisp Light')}</strong>
            <span class="theme-check-dot">✓</span>
          </div>
        </button>
        <button type="button" class="theme-preview-card ${isDark ? 'is-active' : ''}" data-pick-theme="dark" aria-pressed="${isDark}">
          <div class="theme-swatch-screen dark-swatch" aria-hidden="true">
            <div class="swatch-bar-top"><span class="swatch-dot-red"></span><span class="swatch-pill"></span></div>
            <div class="swatch-card-mini"></div>
          </div>
          <div class="theme-card-foot">
            <strong>${L('石墨暗夜', 'Switch Dark')}</strong>
            <span class="theme-check-dot">✓</span>
          </div>
        </button>
      </div>

      <div class="card settings-group-card">
        <div class="settings-row">
          <div class="settings-row-left">
            <span class="icon-badge ${soundOn ? 'emerald' : ''}">${icon(soundOn ? 'volumeOn' : 'volumeOff', 16)}</span>
            <div>
              <div class="settings-row-title">${L('触感交互音效', 'Tactile UI Sound')}</div>
              <div class="settings-row-sub">${L('切页、盖章与确认操作时播放清脆反馈音', 'Crisp chime feedback on tabs, stamps & confirms')}</div>
            </div>
          </div>
          <div class="a9-switch ${soundOn ? 'on' : ''}" id="set-sound-switch" role="switch" aria-checked="${soundOn}" tabindex="0"></div>
        </div>
      </div>

      <div class="section-kicker">${L('账户与连接', 'ACCOUNT & CONNECTIONS')}</div>
      <div class="card settings-group-card">
        <div class="settings-row clickable" id="set-wallet-row">
          <div class="settings-row-left">
            <span class="icon-badge sky">${icon('wallet', 16)}</span>
            <div>
              <div class="settings-row-title">${L('TON 钱包管理', 'TON Wallet')}</div>
              <div class="settings-row-sub mono">${user.connected ? (user.shortAddress || user.address) : L('未连接 · TON Connect 2.0', 'Not connected · TON Connect 2.0')}</div>
            </div>
          </div>
          <span class="chip ${user.connected ? 'chip-green' : 'chip-gold'}">${user.connected ? L('已连接', 'Connected') : L('去连接', 'Connect')}</span>
        </div>

        <div class="settings-row clickable" id="set-tg-row">
          <div class="settings-row-left">
            <span class="icon-badge sky">${icon('send', 15)}</span>
            <div>
              <div class="settings-row-title">${L('Telegram 账号绑定', 'Telegram Binding')}</div>
              <div class="settings-row-sub">${user.tgBound ? user.username : L('宝箱商城与战队功能需绑定', 'Required for Chest Mall & Squad')}</div>
            </div>
          </div>
          <span class="chip ${user.tgBound ? 'chip-green' : 'chip-gold'}">${user.tgBound ? L('已绑定', 'Bound') : L('立即绑定', 'Bind')}</span>
        </div>

        <div class="settings-row clickable" id="set-lang-row">
          <div class="settings-row-left">
            <span class="icon-badge amber">${icon('globe', 16)}</span>
            <div>
              <div class="settings-row-title">${L('界面语言', 'Language')}</div>
              <div class="settings-row-sub">${curLangObj.label}</div>
            </div>
          </div>
          <span class="chip chip-muted">${curLangObj.code} ${icon('chevronDown', 11)}</span>
        </div>
      </div>

      <div class="section-kicker">${L('通知提醒', 'NOTIFICATIONS')}</div>
      <div class="card settings-group-card">
        <div class="settings-row">
          <div class="settings-row-left">
            <span class="icon-badge emerald">${icon('clock', 16)}</span>
            <div>
              <div class="settings-row-title">${L('整点 1H 时段收盘推送', 'Hourly Slot Close Push')}</div>
              <div class="settings-row-sub">${L('观察期每小时定盘达标实时提醒', 'Alert on each hourly TWAP check')}</div>
            </div>
          </div>
          <div class="a9-switch ${settings.hourlyCandlePush ? 'on' : ''}" data-pref="hourlyCandlePush" role="switch" aria-checked="${Boolean(settings.hourlyCandlePush)}" tabindex="0"></div>
        </div>
        <div class="settings-row">
          <div class="settings-row-left">
            <span class="icon-badge amber">${icon('bell', 16)}</span>
            <div>
              <div class="settings-row-title">${L('轮次结算与领取提醒', 'Settlement & Claim Alerts')}</div>
              <div class="settings-row-sub">${L('轮次结算结果与金库可领通知', 'Notify when rounds settle or rewards unlock')}</div>
            </div>
          </div>
          <div class="a9-switch ${settings.settlementPush ? 'on' : ''}" data-pref="settlementPush" role="switch" aria-checked="${Boolean(settings.settlementPush)}" tabindex="0"></div>
        </div>
      </div>

      <div class="grid-2">
        <button class="btn btn-secondary" data-nav="/rules" type="button">${icon('book', 15)} ${L('闯关指南', 'How to Play')}</button>
        <button class="btn btn-secondary" data-nav="/risk/matrix" type="button">${icon('shieldAlert', 15)} ${L('安全护盾', 'Safety Shield')}</button>
      </div>
      ${config.isDemo ? `<button class="btn btn-danger" id="btn-reset-demo" type="button">${icon('refresh', 15)} ${L('重置本地演示数据', 'Reset Demo Data')}</button>` : ''}

      <div class="settings-version-strip">
        <span>A9 Protocol · ${PROTOCOL_SPECS.version}</span>
        <span>${config.isDemo ? 'DEMO SANDBOX' : (store.fundsEnabled ? 'TON LIVE' : 'TON LIVE READ-ONLY')}</span>
      </div>
    </div>
  `;

  root.querySelectorAll('[data-pick-theme]').forEach((btn) => {
    btn.onclick = (e) => {
      const target = btn.dataset.pickTheme;
      if (target === getTheme()) return;
      const next = toggleTheme(e);
      showToast(next === 'dark' ? L('已切换石墨暗夜主题', 'Switched to Switch Dark') : L('已切换雪白亮色主题', 'Switched to Crisp Light'));
      renderSettingsPage(root);
    };
  });

  root.querySelector('#set-wallet-row').onclick = () => tonConnect.openConnectModal(renderCurrentRoute);
  root.querySelector('#set-tg-row').onclick = () => {
    if (!config.isDemo) { showToast(L('请在 Telegram 内核验身份', 'Verify identity in Telegram')); return; }
    A9Haptic.success();
    store.update(s => { s.user.tgBound = !s.user.tgBound; });
    showToast(store.state.user.tgBound ? L('Telegram 已绑定', 'Telegram bound') : L('已模拟解绑 Telegram', 'Telegram unbound'));
    renderSettingsPage(root);
  };
  root.querySelector('#set-lang-row').onclick = () => openChoiceSheet({
    title: L('选择界面语言', 'Select Language'),
    selected: settings.language,
    options: LANGUAGES.map(l => ({ value: l.code, label: l.label, sub: l.sub })),
    onSelect: (code) => {
      store.update(s => { s.settings.language = code; });
      showToast(`${L('已切换语言', 'Language')}: ${code}`);
      renderCurrentRoute();
    }
  });
  const soundSw = root.querySelector('#set-sound-switch');
  if (soundSw) {
    const toggleSound = () => {
      A9Haptic.light();
      const on = A9Audio.toggle();
      showToast(on ? L('触感交互音效已开启', 'Tactile UI Sound On') : L('交互音效已静音', 'Sound Muted'));
      renderSettingsPage(root);
    };
    soundSw.onclick = toggleSound;
    soundSw.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleSound(); } };
  }
  root.querySelectorAll('[data-pref]').forEach(el => {
    const togglePref = () => { A9Haptic.tick(); const k = el.dataset.pref; store.update(s => { s.settings[k] = !s.settings[k]; }); renderSettingsPage(root); };
    el.onclick = togglePref;
    el.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); togglePref(); } };
  });
  const resetBtn = root.querySelector('#btn-reset-demo');
  if (resetBtn) resetBtn.onclick = () => { A9Haptic.warning(); store.reset(); showToast(L('已恢复初始演示数据', 'Demo reset')); renderCurrentRoute(); };
}

export function renderRiskMatrix(root) {
  if (!config.isDemo) {
    root.innerHTML = `<section class="card col-gap"><h2>${L('安全护盾说明', 'Safety Shield Reference')}</h2><p class="num-xs text-sec">${L('真实模式当前处于只读验收阶段，实时风控告警流待主网接入后开放展示；本页仅在演示模式支持模拟拦截。', 'Live mode is read-only; live safety telemetry awaits mainnet integration. Interactive simulations are demo-only.')}</p></section>`;
    return;
  }
  let filter = 'all';
  const render = () => {
    const list = filter === 'all' ? RISK_STATES : RISK_STATES.filter(x => x.cat === filter);
    root.innerHTML = `
      <div class="col-gap anim-page-enter">
        <div class="card card-glow-red">
          <div class="row-between">
            <div>
              <div class="caps text-red">SENTINEL ENGINE ACTIVE</div>
              <div style="font-size:16px;font-weight:700;margin-top:2px;">${L('22 种全状态异常风控矩阵', '22-State On-Chain Risk Matrix')}</div>
            </div>
            <span class="chip chip-green">22/22</span>
          </div>
          <div class="num-xs text-sec" style="margin-top:6px;">${L('点击任意异常卡片可实时触发对应的风控拦截弹窗模拟', 'Tap any guard card to simulate its circuit-breaker modal')}</div>
        </div>

        <div class="seg-tabs">
          <button class="seg-tab ${filter === 'all' ? 'active' : ''}" data-rf="all">${L('全部 22', 'All 22')}</button>
          <button class="seg-tab ${filter === 'wallet' ? 'active' : ''}" data-rf="wallet">${L('钱包/链', 'Wallet')}</button>
          <button class="seg-tab ${filter === 'quota' ? 'active' : ''}" data-rf="quota">${L('额度/观察', 'Round')}</button>
          <button class="seg-tab ${filter === 'market' ? 'active' : ''}" data-rf="market">${L('宝箱商城', 'Mall')}</button>
          <button class="seg-tab ${filter === 'team' ? 'active' : ''}" data-rf="team">${L('战队', 'Squad')}</button>
        </div>

        <div class="col-gap">
          ${list.map(item => `
            <div class="card clickable" data-sim-err="${item.id}" style="cursor:pointer;">
              <div class="row-between" style="margin-bottom:4px;">
                <span class="num-xs text-red">#${item.id} ${item.code}</span>
                <span class="chip chip-amber">${L('模拟拦截', 'Simulate')}</span>
              </div>
              <div style="font-weight:700;font-size:13px;">${L(item.titleZh, item.titleEn)}</div>
              <div class="text-sec" style="font-size:11px;margin-top:3px;">${L(item.descZh, item.descEn)}</div>
            </div>
          `).join('')}
        </div>
      </div>
    `;

    root.querySelectorAll('[data-rf]').forEach(b => {
      b.onclick = () => { A9Haptic.light(); filter = b.dataset.rf; render(); };
    });

    root.querySelectorAll('[data-sim-err]').forEach(card => {
      card.onclick = () => {
        A9Haptic.error();
        const item = RISK_STATES.find(x => x.id === card.dataset.simErr);
        const title = L(item.titleZh, item.titleEn);
        const desc = L(item.descZh, item.descEn);
        const action = L(item.actionZh, item.actionEn);
        openModal(`
          <div class="sheet-handle"></div>
          <div class="row-between">
            <span class="chip chip-red">CIRCUIT BREAKER ARMED</span>
            <span class="num-xs text-muted">${item.code}</span>
          </div>
          <div class="row-start" style="font-size:16px;font-weight:700;">${icon('shieldAlert', 18, 'text-red')} ${title}</div>
          <div class="text-sec" style="font-size:12px;">${desc}</div>
          <button class="btn btn-primary" id="modal-resolve-btn">${icon('bolt', 15)} ${action}</button>
          <button class="btn btn-secondary" id="modal-close-btn">${L('关闭模拟弹窗', 'Close Simulation')}</button>
        `);
        document.getElementById('modal-resolve-btn').onclick = () => {
          closeModal();
          showToast(`${L('已执行风控恢复路径', 'Recovery action executed')}: ${action}`);
        };
        document.getElementById('modal-close-btn').onclick = closeModal;
      };
    });
  };
  render();
}

export function renderRiskAudit(root) {
  const { risk, round } = store.state;
  const cfg = round?.protocolConfig || {};
  const contracts = cfg.contracts || {};
  const network = cfg.network || config.network || 'mainnet';
  const rcAddr = contracts.roundController || null;
  const jettonAddr = contracts.a9JettonMaster || contracts.jettonMaster || null;
  const poolRemA9 = round?.poolState?.poolRemainingRaw ? rawToA9(round.poolState.poolRemainingRaw) : (round?.rewardPoolA9 ?? null);
  const codeHash = cfg.roundControllerCodeHash || cfg.codeHash || null;

  const invariantsBoardHtml = `
    <section class="card card-hero" id="v16-invariants-board">
      <div class="row-between" style="margin-bottom:8px;">
        <div class="card-title">${icon('shieldCheck', 16, 'text-green')} ${L('v16.1 链上防 Rug 安全不变量看板', 'v16.1 On-Chain Security Invariants')}</div>
        <span class="chip chip-green">${config.isDemo ? 'DEMO · v16.1' : 'TVM · v16.1'}</span>
      </div>
      <div class="check-list">
        <div class="check-row">
          <span class="text-sec">${L('管理员权限（admin_address）', 'Admin Address')}</span>
          <span class="mono text-green" style="font-weight:800;">addr_none · ${L('已弃权', 'Renounced')}</span>
        </div>
        <div class="check-row">
          <span class="text-sec">${L('无许可逃生舱（AbortRound）', 'Permissionless Escape Hatch')}</span>
          <span class="mono" style="font-weight:700;">${L('7 天异常可全员退本', '7d AbortRound Refund')}</span>
        </div>
        <div class="check-row">
          <span class="text-sec">${L('链上剩余奖池（poolRemaining）', 'On-Chain Pool Remaining')}</span>
          <span class="mono text-green" style="font-weight:800;">${poolRemA9 !== null && Number.isFinite(Number(poolRemA9)) ? `${formatNum(Math.round(Number(poolRemA9)))} A9` : L('待同步', 'Pending sync')}</span>
        </div>
        <div class="check-row">
          <span class="text-sec">${L('全局推广预算熔断硬顶', 'Global Promo Budget Cap')}</span>
          <span class="mono" style="font-weight:700;">${formatNum(PROTOCOL_SPECS.promoCapA9)} A9</span>
        </div>
        <div class="check-row">
          <span class="text-sec">${L('结算红线 / 奖励上限 / 直推', 'Pass Line / Cap / Referral')}</span>
          <span class="mono num-xs">${PROTOCOL_SPECS.passRequired}/${PROTOCOL_SPECS.passTotal} · ${PROTOCOL_SPECS.maxRewardMultiplier}× · ${PROTOCOL_SPECS.referralPct}%</span>
        </div>
        <div class="check-row">
          <span class="text-sec">RoundController</span>
          <span class="mono num-xs">${rcAddr ? escapeHtml(shortAddress(rcAddr)) : L('主网部署后自动注入', 'Injected at mainnet launch')}</span>
        </div>
        ${jettonAddr ? `
          <div class="check-row">
            <span class="text-sec">A9 Jetton Master</span>
            <span class="mono num-xs">${escapeHtml(shortAddress(jettonAddr))}</span>
          </div>
        ` : ''}
        <div class="check-row">
          <span class="text-sec">${L('合约代码指纹（code_hash）', 'Contract code_hash')}</span>
          <span class="mono num-xs">${codeHash ? escapeHtml(`${String(codeHash).slice(0, 10)}…${String(codeHash).slice(-6)}`) : L('Tonviewer 源码/字节码直查', 'Verify directly on Tonviewer')}</span>
        </div>
      </div>
      <div class="grid-2" style="margin-top:10px;gap:8px;">
        ${rcAddr
          ? `<a class="btn btn-primary btn-sm" href="${escapeHtml(buildTonviewerUrl(rcAddr, network))}" target="_blank" rel="noopener noreferrer">${icon('external', 13)} ${L('Tonviewer 查主合约', 'Inspect on Tonviewer')}</a>
             <button class="btn btn-secondary btn-sm" id="btn-audit-copy-rc" type="button">${icon('copy', 13)} ${L('复制合约地址', 'Copy Address')}</button>`
          : `<a class="btn btn-secondary btn-sm" href="#/rules">${icon('book', 13)} ${L('查看 v16.1 规则', 'View v16.1 Rules')}</a>
             <a class="btn btn-secondary btn-sm" href="#/round">${icon('arrowLeft', 13)} ${L('返回广场', 'Back to Plaza')}</a>`}
      </div>
    </section>
  `;

  if (!config.isDemo) {
    root.innerHTML = `
      <div class="col-gap anim-page-enter">
        ${invariantsBoardHtml}
        <section class="card">
          <div class="row-between" style="margin-bottom:6px;">
            <div class="card-title">${icon('radar', 15, 'text-cyan')} ${L('动态结算与预言机事件流', 'Live Settlement & Oracle Stream')}</div>
            <span class="chip chip-muted">${L('链上同步中', 'SYNCING')}</span>
          </div>
          <p class="num-xs text-sec" style="margin:0;line-height:1.5;">${L('每小时 1H TWAP 定盘与轮次结算哈希将在链上出块后自动归档展示；上方 v16.1 合约不可变安全参数已可直接核验。', 'Hourly TWAP seals and round settlement hashes archive here as blocks finalize; the v16.1 immutable invariants above are live-verifiable now.')}</p>
        </section>
      </div>`;
    const cp = root.querySelector('#btn-audit-copy-rc');
    if (cp && rcAddr) cp.onclick = () => copyText(rcAddr, L('已复制 RoundController 地址', 'Copied RoundController address'));
    return;
  }

  const events = [
    { time: '12:00 UTC', target: L('第 12 时段收盘定盘', 'Slot #12 hourly seal'), detail: 'Pyth + RedStone · 0.12%', result: 'VERIFIED', cls: 'chip-green' },
    { time: '08:00 UTC', target: L('奖池合约余额校验', 'Reward pool balance check'), detail: '700,000,000 A9 · 100%', result: 'PASS', cls: 'chip-green' },
    { time: '00:00 UTC', target: L('v16.1 结算逻辑验真', 'v16.1 settlement verification'), detail: 'RoundController · TVM · addr_none', result: 'AUDITED', cls: 'chip-blue' },
  ];
  root.innerHTML = `
    <div class="col-gap anim-page-enter">
      ${invariantsBoardHtml}
      <div class="card">
        <div class="row-between" style="margin-bottom:8px;">
          <div class="card-title">${icon('shieldCheck', 16, 'text-green')} ${L('预言机与合约健康度', 'Oracle & Contract Health')}</div>
          <span class="chip chip-green">NOMINAL</span>
        </div>
        <div class="metric-strip cols-3" style="margin:0;padding:8px 0 0;border-bottom:0;">
          <div class="metric-cell"><span class="num-xs text-muted">${L('偏离度', 'Deviation')}</span><span class="num-md text-green">${risk.oracleDeviationPct ?? '—'}%</span></div>
          <div class="metric-cell"><span class="num-xs text-muted">${L('节点延迟', 'Latency')}</span><span class="num-md text-cyan">${risk.latencyMs ?? '—'}ms</span></div>
          <div class="metric-cell"><span class="num-xs text-muted">${L('资金校验', 'Funds')}</span><span class="num-md text-green">PASS</span></div>
        </div>
      </div>

      <div class="card">
        <div class="card-header"><div class="card-title">${L('审计日志（时间 · 对象 · 结果）', 'Audit Log (Time · Target · Result)')}</div></div>
        <div>
          ${events.map(ev => `
            <div class="list-row">
              <div>
                <div class="num-xs text-muted mono">${ev.time}</div>
                <div style="font-weight:800;margin-top:1px;">${ev.target}</div>
                <div class="num-xs text-sec">${ev.detail}</div>
              </div>
              <span class="chip ${ev.cls}">${ev.result}</span>
            </div>
          `).join('')}
        </div>
      </div>
    </div>
  `;
  const cp = root.querySelector('#btn-audit-copy-rc');
  if (cp && rcAddr) cp.onclick = () => copyText(rcAddr, L('已复制 RoundController 地址', 'Copied RoundController address'));
}

export function renderRulesPage(root) {
  root.innerHTML = `
    <div class="col-gap anim-page-enter">
      <div class="card card-hero">
        <div class="row-between">
          <div>
            <span class="diorama-kicker">A9 / RULEBOOK</span>
            <h2 style="margin:3px 0 4px;font-size:18px;font-weight:900;">${L('3 分钟玩懂 A9 玩法', 'Understand A9 in 3 Minutes')}</h2>
            <p class="num-xs text-sec" style="margin:0;">${L('动手点一点下方交互图解卡，瞬间看懂早鸟权重份额与 16/24 通关线。', 'Tap & slide the interactive cards below to feel early weights and the 16/24 rule.')}</p>
          </div>
          <span class="nt-art-badge tone-green" style="width:50px;height:50px;" aria-hidden="true">${renderNintendoGateIcon('rules', 32)}</span>
        </div>
      </div>

      <!-- 交互图解卡 1：早鸟权重份额对比 -->
      <section class="card rule-sim-card" id="rule-weight-sim">
        <div class="row-between">
          <div class="card-title">${icon('bolt', 15, 'text-gold')} ${L('交互图解 · 早鸟权重份额', 'Interactive · Early Weight')}</div>
          <span class="chip chip-gold mono">${L('上限 15×', '15× Cap')}</span>
        </div>
        <div class="weight-fold-grid" role="group" aria-label="${L('选择早鸟档位', 'Select early tier')}">
          <button type="button" class="weight-fold-btn active" data-rule-weight="2.0" aria-pressed="true">
            <strong>2.0×</strong>
            <small>${L('首段早鸟', 'Early')}</small>
          </button>
          <button type="button" class="weight-fold-btn" data-rule-weight="1.4" aria-pressed="false">
            <strong>1.4×</strong>
            <small>${L('中段稳进', 'Middle')}</small>
          </button>
          <button type="button" class="weight-fold-btn" data-rule-weight="1.0" aria-pressed="false">
            <strong>1.0×</strong>
            <small>${L('末段压哨', 'Late')}</small>
          </button>
        </div>
        <div class="rule-verdict-box" id="rule-weight-output">
          <div class="row-between num-xs">
            <span class="text-sec">${L('假设参与 1,000 A9 折算权重', '1,000 A9 effective weight')}</span>
            <b class="mono text-gold" id="rule-weight-val">${L('2,000 权重份（相对末段 2.00 倍）', '2,000 shares (2.00× vs late)')}</b>
          </div>
          <div class="num-xs text-muted" id="rule-weight-desc">${L('仅影响达标后奖励池瓜分份额，不改变本金或 15 倍封顶上限。', 'Only affects reward pool share on passing rounds; 15× cap unchanged.')}</div>
        </div>
      </section>

      <!-- 交互图解卡 2：24H 达标通关线推演滑杆 -->
      <section class="card rule-sim-card" id="rule-slot-sim">
        <div class="row-between">
          <div class="card-title">${icon('radar', 15, 'text-cyan')} ${L('交互图解 · 24H 通关线推演', 'Interactive · 16/24 Threshold')}</div>
          <span class="chip chip-green mono" id="rule-slot-pill">16 / 24</span>
        </div>
        <div class="rule-range-wrap">
          <input class="rule-range-input" id="rule-slot-range" type="range" min="0" max="24" step="1" value="16" aria-label="${L('模拟达标时段数', 'Simulate qualified slots')}">
          <div class="row-between num-xs text-muted mono">
            <span>0</span>
            <span class="text-gold" style="font-weight:800;">★ 16 ${L('达标线', 'Goal')}</span>
            <span>24</span>
          </div>
        </div>
        <div class="rule-verdict-box pass" id="rule-slot-output">
          <div class="row-between num-xs">
            <b id="rule-slot-title" class="text-green">${L('达标胜出 ✓ · 解锁本轮奖池', 'Round Passed ✓ · Pool Unlocked')}</b>
            <span class="mono text-sec" id="rule-slot-sub">16 ≥ 16</span>
          </div>
          <div class="num-xs text-sec" id="rule-slot-desc">${L('按全网累计胜场阶梯释放：1–5 胜即时 20%，6–10 胜即时 40%，11 胜起 100% 秒领。', 'Vesting by global wins: 1–5 wins 20%, 6–10 wins 40%, 11+ wins 100% instant.')}</div>
        </div>
      </section>

      <div class="card">
        <details class="faq-item" open>
          <summary><span>${L('1. 早鸟权重怎么计算？', '1. How do early weights work?')}</span><span class="faq-arrow">${icon('chevronDown', 15)}</span></summary>
          <div class="faq-body">
            ${L('参与窗口分为三档早鸟权重：首段 2.0×、中段 1.4×、末段 1.0×。早鸟权重只影响当轮达标后的奖励分配份额，不改变本金规则。', 'Entry has 3 weight tiers: Early 2.0×, Middle 1.4×, Late 1.0×. Weights only affect reward share when a round passes.')}
          </div>
        </details>

        <details class="faq-item">
          <summary><span>${L('2. 24H 观测盘怎样才算达标？', '2. How does the 24H board qualify?')}</span><span class="faq-arrow">${icon('chevronDown', 15)}</span></summary>
          <div class="faq-body">
            ${L('观察期共 24 个 1 小时时段。每个时段判定均价 ≥ 目标底价即盖下达标绿章，累计至少 16 个达标时段即本轮胜出；单轮个人奖励上限为实缴本金 15 倍，未分配部分自动滚存至下一轮。', '24 hourly slots are tracked. Each slot meeting or exceeding the target earns a green stamp. 16+ stamps pass the round; single-round reward is capped at 15× principal.')}
          </div>
        </details>

        <details class="faq-item">
          <summary><span>${L('3. 奖励分几档解锁？失败会怎样？', '3. How do vesting tiers and failures work?')}</span><span class="faq-arrow">${icon('chevronDown', 15)}</span></summary>
          <div class="faq-body">
            ${L('全网第 1–5 胜即时解锁 20%（余下 4×20% 随后续达标轮释放）；第 6–10 胜即时解锁 40%（余下 2×30%）；第 11 胜起新奖励 100% 即时可领（v16.1：零质押达标轮不推进胜场与锁仓解锁）。失败轮销毁该轮质押本金、一半当轮奖池（含团队结转池对称减半销毁）与未解锁份额，直到总奖池耗尽。', 'Wins 1–5 unlock 20% immediately (4×20% vested); wins 6–10 unlock 40% (2×30%); wins 11+ unlock 100% immediately (v16.1: zero-stake passing rounds do not advance global wins or unlock slices). Failed rounds burn round principal, half of the round & team carry pools, and unvested slices.')}
          </div>
        </details>

        <details class="faq-item">
          <summary><span>${L('4. 邀友奖励与推广激励如何领取？', '4. How are invite & promo rewards claimed?')}</span><span class="faq-arrow">${icon('chevronDown', 15)}</span></summary>
          <div class="faq-body">
            ${L('后台独立核算直推宝箱返佣（6%）与活动奖励，受 3 亿 A9 全局推广预算熔断保护。领取时支付 0.06 GRAM 网络费用，由推广热钱包自动发 A9。当前真实模式处于只读验收阶段，真实领取入口暂未开放。', 'Direct chest referrals (6%) and promo rewards are tracked off-chain under a 300,000,000 A9 global budget cap. Claiming pays a 0.06 GRAM network fee and the hot wallet sends A9. Live claims are currently disabled in read-only mode.')}
          </div>
        </details>
      </div>

      <button class="btn btn-secondary" data-nav="/risk/matrix">${icon('shieldAlert', 15)} ${L('查看 22 项链上风控保护', 'View 22 On-Chain Risk Guards')}</button>
    </div>
  `;

  // 绑定交互图解卡 1：早鸟权重切换
  const wVal = root.querySelector('#rule-weight-val');
  const wDesc = root.querySelector('#rule-weight-desc');
  root.querySelectorAll('[data-rule-weight]').forEach((btn) => {
    btn.onclick = () => {
      A9Haptic.tick();
      A9Audio.pageTurn();
      const mult = Number(btn.dataset.ruleWeight) || 1;
      root.querySelectorAll('[data-rule-weight]').forEach((b) => {
        const on = b === btn;
        b.classList.toggle('active', on);
        b.setAttribute('aria-pressed', String(on));
      });
      if (wVal) {
        const shares = Math.round(1000 * mult).toLocaleString('en-US');
        wVal.textContent = L(
          `${shares} 权重份（相对末段 ${mult.toFixed(2)} 倍）`,
          `${shares} shares (${mult.toFixed(2)}× vs late)`
        );
      }
      if (wDesc) {
        wDesc.textContent = mult === 2
          ? L('首段早鸟享有最高 2.0× 分配权重，同样本金分得双倍基础份额。', 'Early 2.0× earns double base reward weight for the same principal.')
          : mult === 1.4
            ? L('中段参与享有 1.4× 权重，在节奏与份额间取得平衡。', 'Middle tier earns 1.4× weight, balancing timing and share.')
            : L('末段按 1.0× 基础权重计入，仍享受完整的 15× 奖励封顶空间。', 'Late entry counts at 1.0× base weight with full 15× reward cap.');
      }
    };
  });

  // 绑定交互图解卡 2：24H 生死线推演滑杆
  const rangeEl = root.querySelector('#rule-slot-range');
  const slotPill = root.querySelector('#rule-slot-pill');
  const slotOut = root.querySelector('#rule-slot-output');
  const slotTitle = root.querySelector('#rule-slot-title');
  const slotSub = root.querySelector('#rule-slot-sub');
  const slotDesc = root.querySelector('#rule-slot-desc');
  if (rangeEl) {
    let prevSlot = Number(rangeEl.value);
    rangeEl.oninput = () => {
      const v = Number(rangeEl.value);
      if (v !== prevSlot) {
        A9Haptic.tick();
        if (v === 16) A9Audio.scaleChime(16);
        else A9Audio.ratchet(Math.max(1, Math.min(9, Math.ceil((v / 24) * 9))));
        prevSlot = v;
      }
      const pass = v >= 16;
      if (slotPill) {
        slotPill.textContent = `${v} / 24`;
        slotPill.className = `chip ${pass ? 'chip-green' : 'chip-red'} mono`;
      }
      if (slotOut) {
        slotOut.classList.toggle('pass', pass);
        slotOut.classList.toggle('burn', !pass);
      }
      if (slotTitle) {
        slotTitle.className = pass ? 'text-green' : 'text-red';
        slotTitle.textContent = pass
          ? L('达标胜出 ✓ · 解锁本轮奖池', 'Round Passed ✓ · Pool Unlocked')
          : L('未达门槛 × · 触发对称销毁', 'Below 16 × · Symmetric Burn');
      }
      if (slotSub) {
        slotSub.textContent = pass ? `${v} ≥ 16` : `${v} < 16（${L(`差 ${16 - v} 段`, `${16 - v} short`)}）`;
      }
      if (slotDesc) {
        slotDesc.textContent = pass
          ? L('按全网累计胜场阶梯释放：1–5 胜即时 20%，6–10 胜即时 40%，11 胜起 100% 秒领。', 'Vesting by global wins: 1–5 wins 20%, 6–10 wins 40%, 11+ wins 100% instant.')
          : L('失败轮按 v16.1 规则销毁当轮质押本金、一半当轮奖池与未解锁余量，另一半滚存下轮。', 'Failed rounds burn round principal, half of the round pool, and unvested balances.');
      }
    };
  }
}

export function renderNotFoundPage(root) {
  root.innerHTML = `
    <div class="col-gap anim-page-enter">
      <div class="card empty-state">
        <div class="icon-badge red" style="width:46px;height:46px;border-radius:13px;">${icon('shieldAlert', 22)}</div>
        <div class="num-xl" style="margin-top:4px;">404</div>
        <div class="text-sec" style="font-size:12px;">${L('该页面不存在或路由链接已失效', 'This page was not found or the link has expired')}</div>
        <button class="btn btn-primary btn-sm" style="margin-top:8px;" data-nav="/challenge">${icon('arrowLeft', 14)} ${L('返回 A9 广场', 'Back to Plaza')}</button>
      </div>
    </div>
  `;
}
