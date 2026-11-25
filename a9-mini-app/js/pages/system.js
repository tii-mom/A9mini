import { renderNintendoGateIcon } from '../paper-art.js';
/**
 * System Settings, 22-State Risk Matrix, On-Chain Audit Log & Protocol Rules Pages
 * Zero-Emoji + Real Bilingual Switcher + /rules Manual
 */

import { store } from '../store.js';
import { config } from '../config.js';
import { A9Haptic, A9TMA } from '../tma.js';
import { A9Audio } from '../audio.js';
import { showToast, openModal, closeModal, formatNum, copyText, escapeHtml } from '../components.js';
import { icon } from '../icons.js';
import { L, LANGUAGES } from '../i18n.js';
import { openChoiceSheet } from '../components.js';
import { tonConnect } from '../tonconnect.js';
import { renderCurrentRoute, getTheme, toggleTheme } from '../app.js';
import { PROTOCOL_SPECS, rawToA9, fetchNotificationPrefs, updateNotificationPrefs } from '../data.js';
import { buildTonviewerUrl, shortAddress } from '../tx-ux.js';

let liveNotifCache = { fetched: false, settlementPush: null, error: null, saving: false };
let settingsRenderSeq = 0;

/** 测试辅助：重置设置页通知偏好内存缓存，绝不接触持久化存储 */
export function resetLiveNotificationCacheForTest() {
  liveNotifCache = { fetched: false, settlementPush: null, error: null, saving: false };
  settingsRenderSeq = 0;
}

const RISK_STATES = [
  { id: '01', code: 'ERR_0x1301_TON_REJECTED', cat: 'wallet', titleZh: '钱包未连接 / 签名主动拒绝', titleEn: 'Wallet Not Connected / Signature Rejected', descZh: '用户在 TON Connect 2.0 握手时关闭窗口或拒绝签名。', descEn: 'User closed TON Connect 2.0 modal or rejected transaction signing.', actionZh: '快速重新连接钱包', actionEn: 'Reconnect Wallet' },
  { id: '02', code: 'ERR_0x1302_INSUFFICIENT_GAS', cat: 'wallet', titleZh: '余额不足支付 Gas / 锁仓本金', titleEn: 'Insufficient Gas or Lock Principal', descZh: '钱包可用 A9 不足锁仓下限（100 A9），或 GRAM 不足覆盖 0.30 GRAM 合约调用 Gas。', descEn: 'Available A9 is below 100 A9 lock minimum or GRAM is insufficient for 0.30 GRAM contract gas.', actionZh: '检查钱包余额', actionEn: 'Check Wallet Balance' },
  { id: '03', code: 'ERR_0x1303_MEMPOOL_TIMEOUT', cat: 'wallet', titleZh: '链上 RPC 广播超时 / 拥堵', titleEn: 'On-Chain RPC Broadcast Timeout', descZh: 'Toncenter 节点延迟超过 8000ms，交易滞留 Mempool。', descEn: 'Toncenter RPC latency exceeded 8000ms; tx pending in mempool.', actionZh: '自动切换备用 L1 RPC', actionEn: 'Switch Fallback L1 RPC' },
  { id: '04', code: 'ERR_0x1304_BELOW_MIN_STAKE', cat: 'wallet', titleZh: '锁仓金额低于 100 A9 最小门槛', titleEn: 'Lock Below 100 A9 Minimum', descZh: 'v17.0 合约单次锁仓需确保至少 100 A9 完整单元。', descEn: 'v17.0 contract requires a minimum single lock of 100 A9.', actionZh: '一键补齐至 100 A9', actionEn: 'Fill to 100 A9' },
  { id: '05', code: 'ERR_0x1305_EXCEED_5X_HARDCAP', cat: 'wallet', titleZh: '超过 5× 单轮奖金封顶', titleEn: '5× Single-Round Reward Cap Reached', descZh: '触达单轮 5 倍币封顶上限，超额部分 100% 滚存至下轮奖池。', descEn: 'Reward reached the 5× principal hard cap; excess rolls 100% into next round.', actionZh: '查看封顶上限说明', actionEn: 'View Cap Rules' },
  { id: '06', code: 'ERR_0x7E4F_LOCK_CLOSED_EXIT', cat: 'quota', titleZh: '12H 冲价封盘禁止提前解押', titleEn: '12H Push Locked · Early Exit Blocked', descZh: '已进入 12H 冲价封盘期（Errors.LockClosed），禁进禁出防中途砸盘。', descEn: 'Entered 12H Push window (Errors.LockClosed); both entry and early exit are locked.', actionZh: '追踪当前 12H 冲价', actionEn: 'Track 12H Push' },
  { id: '07', code: 'ERR_0x2207_STAGE_CLOSED_LOCKOUT', cat: 'quota', titleZh: '24H 锁仓已封盘 / 进入 12H 冲价', titleEn: '24H Lock Closed · 12H Push Live', descZh: '本轮锁仓通道关闭，转入连续 12 小时冲价结算（≥ 8/12 通关）。', descEn: 'Lock window closed; now in the 12H Push phase (≥ 8/12 to pass).', actionZh: '追踪当前 12H 冲价', actionEn: 'Track 12H Push' },
  { id: '08', code: 'ERR_0x2208_OBSERVE_FAILED_SL', cat: 'quota', titleZh: '12H 冲价未达标 (< 8/12 格)', titleEn: '12H Push Missed (< 8/12 Slots)', descZh: '永不爆仓：头矿 6H 退 95%（烧 5%）、普通退 90%（烧 10%），另烧半池并滚存另一半。', descEn: 'No liquidation: First 6H refunds 95% (5% burn), late refunds 90% (10% burn) + half-pool burn.', actionZh: '前往领回止损退本', actionEn: 'Claim Stop-Loss Refund' },
  { id: '09', code: 'ERR_0x2209_ORACLE_CIRCUIT_BREAK', cat: 'quota', titleZh: '预言机喂价异常熔断 (Pyth/RedStone)', titleEn: 'Oracle Deviation Circuit Breaker', descZh: '跨链报价偏差超阈值，系统自动开启安全隔离并 100% 退还本金。', descEn: 'Oracle price feed deviation triggered safety halt; 100% principal refunded.', actionZh: '查看熔断审计报告', actionEn: 'View Audit Report' },
  { id: '10', code: 'ERR_0x2210_NO_CLAIMABLE_BAL', cat: 'quota', titleZh: '待领取奖金为空', titleEn: 'No Claimable Rewards', descZh: '当前可提取额度为 0，其余奖金正按 14 天（每日 5.71%）逐秒解锁中，亦可走 3 折急提。', descEn: 'Claimable balance is 0; remaining rewards unlock per second over 14 days (5.71%/day), or use 30% Instant Cashout.', actionZh: '查看解锁节奏', actionEn: 'View Unlock Schedule' },
  { id: '11', code: 'ERR_0x2211_GAS_ESTIMATE_FAIL', cat: 'quota', titleZh: '智能合约领取 Gas 估算失败', titleEn: 'Claim Gas Estimation Failed', descZh: '普通领奖需附带 0.22 GRAM，提前解押/3 折急提需附带 0.34 GRAM（余量原路退回）。', descEn: 'Attach 0.22 GRAM for normal claim or 0.34 GRAM for Early Exit / Instant Cashout (excess refunded).', actionZh: '核对附带 Gas 重试', actionEn: 'Retry with Gas' },
  { id: '12', code: 'ERR_0x3312_TG_AUTH_REQUIRED', cat: 'market', titleZh: '未绑定 TG 账号阻断宝箱商城操作', titleEn: 'Telegram Binding Required for Chest Mall', descZh: '独立外部钱包缺少 Telegram InitData 签名校验。', descEn: 'External wallet session lacks Telegram InitData verification.', actionZh: '绑定 Telegram 账号', actionEn: 'Bind Telegram Account' },
  { id: '13', code: 'ERR_0x3313_PRESALE_SOLD_OUT', cat: 'market', titleZh: '宝箱商城当期额度已售罄 (Sold Out)', titleEn: 'Chest Mall Round Quota Sold Out', descZh: '当期宝箱库存已抢空，后发交易扣除 0.03 GRAM 链上退款 Gas 后原路退还。', descEn: 'Current chest allocation is sold out; late txs are refunded minus 0.03 GRAM gas.', actionZh: '查询自动退款流水', actionEn: 'Check Refund Log' },
  { id: '14', code: 'ERR_0x3314_USER_CANCELLATION', cat: 'market', titleZh: '用户主动取消宝箱商城订单', titleEn: 'Chest Mall Order Cancelled by User', descZh: '锁仓前主动撤单，扣除固定链上计算损耗后退回余额。', descEn: 'Order cancelled before lock; balance returned minus gas overhead.', actionZh: '确认撤单规则', actionEn: 'Confirm Cancel Rules' },
  { id: '15', code: 'ERR_0x3315_DUST_NON_REFUNDABLE', cat: 'market', titleZh: '粉尘金额转账 (≤0.1 GRAM 拦截)', titleEn: 'Dust Transfer Blocked (≤ 0.1 GRAM)', descZh: '微小数额低于链上拆单成本，协议直接拦截。', descEn: 'Amount is below minimum on-chain processing threshold.', actionZh: '调整至有效档位', actionEn: 'Select Valid Tier' },
  { id: '16', code: 'ERR_0x4416_CAPTAIN_CANNOT_EXIT', cat: 'team', titleZh: '战队队长试图退队阻断', titleEn: 'Squad Captain Exit Blocked', descZh: '队长绑定分润金库，需先移交队长权限方可离队。', descEn: 'Captain is bound to squad treasury; transfer leadership before leaving.', actionZh: '前往移交队长权限', actionEn: 'Transfer Captaincy' },
  { id: '17', code: 'ERR_0x4417_TEAM_SWITCH_QUOTA', cat: 'team', titleZh: '赛季内切换战队超过 1 次限制', titleEn: 'Squad Switch Limit Exceeded', descZh: '每个赛季严格限制仅可迁移战队 1 次，防止套利。', descEn: 'Each season allows at most 1 squad transfer.', actionZh: '等待下赛季重置', actionEn: 'Wait for Next Season' },
  { id: '18', code: 'ERR_0x4418_PREHEAT_ELIGIBILITY', cat: 'team', titleZh: '开局预热未达到有效直邀门槛', titleEn: 'Pre-Round Invite Threshold Unmet', descZh: '需至少邀请 1 位完成认证的真实伙伴以激活排位资格。', descEn: 'Invite at least 1 verified friend to qualify for pre-round ranking.', actionZh: '分享专属邀请链', actionEn: 'Share Invite Link' },
  { id: '19', code: 'ERR_0x4419_INVITE_HARDCAP', cat: 'team', titleZh: '邀友奖励达 320,000 A9 单轮硬顶', titleEn: '320,000 A9 Round Invite Cap Reached', descZh: '单地址单轮邀友奖励封顶，多余积分自动转入社区奖池。', descEn: 'Single-address invite reward capped per round; excess goes to community pool.', actionZh: '查看邀友奖励上限', actionEn: 'View Invite Cap' },
  { id: '20', code: 'ERR_0x5520_TG_BOT_PERM_LOST', cat: 'sys', titleZh: 'TG 群组解绑 / Bot 管理员权限丢失', titleEn: 'TG Group Unlinked / Bot Admin Lost', descZh: '关联群组撤销了官方 Bot (@A9_TonBot) 管理员权限。', descEn: 'Linked group revoked official Bot (@A9_TonBot) admin permissions.', actionZh: '重新授权 Bot Admin', actionEn: 'Re-authorize Bot Admin' },
  { id: '21', code: 'ERR_0x5521_RENEWAL_TIMEOUT', cat: 'sys', titleZh: '开盘提醒设置锁定 (<30分钟)', titleEn: 'Opening Alert Lockout (< 30 Mins)', descZh: '已进入新轮开盘前 30 分钟锁定缓冲期。', descEn: 'Locked within 30 minutes prior to the next round open.', actionZh: '等待下轮开盘后调整', actionEn: 'Adjust After Open' },
  { id: '22', code: 'ERR_0x5522_API_MAINTENANCE', cat: 'sys', titleZh: '接口只读维护窗口', titleEn: 'API Maintenance Window', descZh: 'v17.0 合约永久弃权不可升级；仅维护边缘只读接口，链上资产不受影响。', descEn: 'v17.0 contracts are renounced; edge API maintenance does not affect on-chain assets.', actionZh: '查看链上验真地址', actionEn: 'Verify On-Chain' }
];

export function renderSettingsPage(root) {
  const { settings, user } = store.state;
  const curLangObj = LANGUAGES.find(l => l.code === settings.language) || LANGUAGES[0];
  const isDark = getTheme() === 'dark';
  const soundOn = A9Audio.isEnabled();
  const isDemo = config.isDemo;
  const hasInitData = !isDemo && Boolean(A9TMA.getRawInitData());
  const seq = ++settingsRenderSeq;

  const liveSettleActive = Boolean(hasInitData && liveNotifCache.fetched && liveNotifCache.settlementPush === true);
  const hourlySubText = isDemo
    ? L('12H 冲价每小时定盘达标实时提醒', 'Alert on each hourly 12H Push check')
    : L('由战队 TG 群自动播报（个人私聊待开放）', 'Auto-posted in Squad TG group (DM coming soon)');
  const settleSubText = isDemo
    ? L('轮次结算结果与金库可领通知', 'Notify when rounds settle or rewards unlock')
    : (!hasInitData
        ? L('请在 Telegram 小程序内打开以管理结算私聊提醒', 'Open in Telegram Mini App to manage settlement DM alerts')
        : (liveNotifCache.saving
            ? L('正在保存设置…', 'Saving preference…')
            : (liveNotifCache.error
                ? L('提醒状态同步失败，请稍后重试', 'Failed to sync alert preference')
                : (!liveNotifCache.fetched
                    ? L('正在同步服务端提醒状态…', 'Syncing alert preference…')
                    : (liveSettleActive
                        ? L('已开启 Telegram 私聊结算与领取提醒', 'Telegram DM settlement & claim alerts ON')
                        : L('已关闭 Telegram 私聊结算与领取提醒', 'Telegram DM settlement & claim alerts OFF'))))));

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
        <div class="settings-row clickable" role="button" tabindex="0" id="set-wallet-row">
          <div class="settings-row-left">
            <span class="icon-badge sky">${icon('wallet', 16)}</span>
            <div>
              <div class="settings-row-title">${L('TON 钱包管理', 'TON Wallet')}</div>
              <div class="settings-row-sub mono">${escapeHtml(user.connected ? (user.shortAddress || user.address) : L('未连接 · TON Connect 2.0', 'Not connected · TON Connect 2.0'))}</div>
            </div>
          </div>
          <span class="chip ${user.connected ? 'chip-green' : 'chip-gold'}">${user.connected ? L('已连接', 'Connected') : L('去连接', 'Connect')}</span>
        </div>

        <div class="settings-row clickable" role="button" tabindex="0" id="set-tg-row">
          <div class="settings-row-left">
            <span class="icon-badge sky">${icon('send', 15)}</span>
            <div>
              <div class="settings-row-title">${L('Telegram 账号绑定', 'Telegram Binding')}</div>
              <div class="settings-row-sub">${escapeHtml(user.tgBound ? user.username : L('宝箱商城与战队功能需绑定', 'Required for Chest Mall & Squad'))}</div>
            </div>
          </div>
          <span class="chip ${user.tgBound ? 'chip-green' : 'chip-gold'}">${user.tgBound ? L('已绑定', 'Bound') : L('立即绑定', 'Bind')}</span>
        </div>

        <div class="settings-row clickable" role="button" tabindex="0" id="set-lang-row">
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
              <div class="settings-row-sub">${hourlySubText}</div>
            </div>
          </div>
          ${isDemo
            ? `<div class="a9-switch ${settings.hourlyCandlePush ? 'on' : ''}" id="set-hourly-push-switch" data-pref="hourlyCandlePush" role="switch" aria-checked="${Boolean(settings.hourlyCandlePush)}" tabindex="0"></div>`
            : `<div class="a9-switch disabled" id="set-hourly-push-switch" role="switch" aria-checked="false" aria-disabled="true"></div>`}
        </div>
        <div class="settings-row">
          <div class="settings-row-left">
            <span class="icon-badge amber">${icon('bell', 16)}</span>
            <div>
              <div class="settings-row-title">${L('轮次结算与领取提醒', 'Settlement & Claim Alerts')}</div>
              <div class="settings-row-sub" id="set-settlement-push-sub">${settleSubText}</div>
            </div>
          </div>
          ${isDemo
            ? `<div class="a9-switch ${settings.settlementPush ? 'on' : ''}" id="set-settlement-push-switch" data-pref="settlementPush" role="switch" aria-checked="${Boolean(settings.settlementPush)}" tabindex="0"></div>`
            : (!hasInitData
                ? `<div class="a9-switch disabled" id="set-settlement-push-switch" role="switch" aria-checked="false" aria-disabled="true"></div>`
                : `<div class="a9-switch ${liveSettleActive ? 'on' : ''}${liveNotifCache.saving ? ' disabled' : ''}" id="set-settlement-push-switch" role="switch" aria-checked="${liveSettleActive}" aria-disabled="${liveNotifCache.saving ? 'true' : 'false'}" tabindex="0"></div>`)}
        </div>
      </div>

      <div class="grid-2">
        <button class="btn btn-secondary" data-nav="/rules" type="button">${icon('book', 15)} ${L('闯关指南', 'How to Play')}</button>
        <button class="btn btn-secondary" data-nav="/risk/matrix" type="button">${icon('shieldAlert', 15)} ${L('安全护盾', 'Safety Shield')}</button>
      </div>
      ${config.isDemo ? `<button class="btn btn-danger" id="btn-reset-demo" type="button">${icon('refresh', 15)} ${L('重置本地演示数据', 'Reset Demo Data')}</button>` : ''}

      <section class="card row-start"><img loading="lazy" src="./assets/boxheads/activity/avatars/act-01.png" width="48" height="48" alt="">
        <div><strong>${L('关于 A9', 'About A9')}</strong><p>${L('A9 · 财富大冒险', 'A9 · Wealth Quest')}</p></div>
      </section>
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

  const walletRow = root.querySelector('#set-wallet-row');
  if (walletRow) walletRow.onclick = () => tonConnect.openConnectModal(renderCurrentRoute);
  const tgRow = root.querySelector('#set-tg-row');
  if (tgRow) {
    tgRow.onclick = () => {
      if (!config.isDemo) { showToast(L('请在 Telegram 内核验身份', 'Verify identity in Telegram')); return; }
      A9Haptic.success();
      store.update(s => { s.user.tgBound = !s.user.tgBound; });
      showToast(store.state.user.tgBound ? L('Telegram 已绑定', 'Telegram bound') : L('已模拟解绑 Telegram', 'Telegram unbound'));
      renderSettingsPage(root);
    };
  }
  const langRow = root.querySelector('#set-lang-row');
  if (langRow) {
    langRow.onclick = () => openChoiceSheet({
      title: L('选择界面语言', 'Select Language'),
      selected: settings.language,
      options: LANGUAGES.map(l => ({ value: l.code, label: l.label, sub: l.sub })),
      onSelect: (code) => {
        store.update(s => { s.settings.language = code; });
        showToast(`${L('已切换语言', 'Language')}: ${code}`);
        renderCurrentRoute();
      }
    });
  }
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
  if (isDemo) {
    root.querySelectorAll('[data-pref]').forEach(el => {
      const togglePref = () => { A9Haptic.tick(); const k = el.dataset.pref; store.update(s => { s.settings[k] = !s.settings[k]; }); renderSettingsPage(root); };
      el.onclick = togglePref;
      el.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); togglePref(); } };
    });
  } else if (hasInitData) {
    const settleSw = root.querySelector('#set-settlement-push-switch');
    const settleSub = root.querySelector('#set-settlement-push-sub');
    const applyLiveUi = () => {
      if (seq !== settingsRenderSeq || root.isConnected === false || !settleSw || settleSw.isConnected === false) return;
      const curOn = Boolean(liveNotifCache.fetched && liveNotifCache.settlementPush === true);
      if (settleSw.classList) {
        settleSw.classList.toggle('on', curOn);
        settleSw.classList.toggle('disabled', Boolean(liveNotifCache.saving));
      }
      settleSw.setAttribute?.('aria-checked', String(curOn));
      settleSw.setAttribute?.('aria-disabled', String(Boolean(liveNotifCache.saving)));
      if (settleSub) {
        if (liveNotifCache.saving) {
          settleSub.textContent = L('正在保存设置…', 'Saving preference…');
        } else if (liveNotifCache.error && liveNotifCache.settlementPush === null) {
          settleSub.textContent = L('提醒状态同步失败，请稍后重试', 'Failed to sync alert preference');
        } else if (!liveNotifCache.fetched) {
          settleSub.textContent = L('正在同步服务端提醒状态…', 'Syncing alert preference…');
        } else {
          settleSub.textContent = curOn
            ? L('已开启 Telegram 私聊结算与领取提醒', 'Telegram DM settlement & claim alerts ON')
            : L('已关闭 Telegram 私聊结算与领取提醒', 'Telegram DM settlement & claim alerts OFF');
        }
      }
    };

    const syncLivePrefs = () => {
      fetchNotificationPrefs()
        .then((res) => {
          const on = Boolean(res?.settlementPush);
          liveNotifCache = { fetched: true, settlementPush: on, error: null, saving: false };
          store.update(s => { s.settings.settlementPush = on; });
          applyLiveUi();
        })
        .catch(() => {
          liveNotifCache = { fetched: true, settlementPush: null, error: 'SYNC_FAILED', saving: false };
          applyLiveUi();
        });
    };

    if (!liveNotifCache.fetched && !liveNotifCache.saving) {
      syncLivePrefs();
    }

    if (settleSw) {
      const toggleLiveSettle = async () => {
        if (liveNotifCache.saving) return;
        if (!liveNotifCache.fetched || (liveNotifCache.error && liveNotifCache.settlementPush === null)) {
          liveNotifCache = { fetched: false, settlementPush: null, error: null, saving: false };
          applyLiveUi();
          syncLivePrefs();
          return;
        }
        A9Haptic.tick();
        const prev = Boolean(liveNotifCache.settlementPush);
        const next = !prev;
        liveNotifCache = { fetched: true, settlementPush: next, error: null, saving: true };
        applyLiveUi();
        try {
          const res = await updateNotificationPrefs({ settlementPush: next });
          const saved = Boolean(res?.settlementPush);
          liveNotifCache = { fetched: true, settlementPush: saved, error: null, saving: false };
          store.update(s => { s.settings.settlementPush = saved; });
          applyLiveUi();
          showToast(saved
            ? L('已开启轮次结算私聊提醒', 'Settlement DM alerts enabled')
            : L('已关闭轮次结算私聊提醒', 'Settlement DM alerts disabled'));
        } catch (e) {
          liveNotifCache = { fetched: true, settlementPush: prev, error: 'SAVE_FAILED', saving: false };
          applyLiveUi();
          showToast(e?.message || L('提醒设置保存失败，请重试', 'Failed to save alert preference'));
        }
      };
      settleSw.onclick = toggleLiveSettle;
      settleSw.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleLiveSettle(); } };
    }
  }
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
            <div class="card clickable" role="button" tabindex="0" data-sim-err="${item.id}" style="cursor:pointer;">
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
        <div class="card-title">${icon('shieldCheck', 16, 'text-green')} ${L('v17.0 链上防 Rug 安全不变量看板', 'v17.0 On-Chain Security Invariants')}</div>
        <span class="chip chip-green">${config.isDemo ? 'DEMO · v17.0' : 'TVM · v17.0'}</span>
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
          : `<a class="btn btn-secondary btn-sm" href="#/rules">${icon('book', 13)} ${L('查看 v17.0 规则', 'View v17.0 Rules')}</a>
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
          <p class="num-xs text-sec" style="margin:0;line-height:1.5;">${L('每小时 1H TWAP 定盘与轮次结算哈希将在链上出块后自动归档展示；上方 v17.0 合约不可变安全参数已可直接核验。', 'Hourly TWAP seals and round settlement hashes archive here as blocks finalize; the v17.0 immutable invariants above are live-verifiable now.')}</p>
        </section>
      </div>`;
    const cp = root.querySelector('#btn-audit-copy-rc');
    if (cp && rcAddr) cp.onclick = () => copyText(rcAddr, L('已复制 RoundController 地址', 'Copied RoundController address'));
    return;
  }

  const events = [
    { time: '12:00 UTC', target: L('第 12 时段收盘定盘', 'Slot #12 hourly seal'), detail: 'Pyth + RedStone · 0.12%', result: 'VERIFIED', cls: 'chip-green' },
    { time: '08:00 UTC', target: L('奖池合约余额校验', 'Reward pool balance check'), detail: '700,000,000 A9 · 100%', result: 'PASS', cls: 'chip-green' },
    { time: '00:00 UTC', target: L('v17.0 结算逻辑验真', 'v17.0 settlement verification'), detail: 'RoundController · TVM · addr_none', result: 'AUDITED', cls: 'chip-blue' },
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
                <div class="num-xs text-muted mono">${escapeHtml(ev.time)}</div>
                <div style="font-weight:800;margin-top:1px;">${escapeHtml(ev.target)}</div>
                <div class="num-xs text-sec">${escapeHtml(ev.detail)}</div>
              </div>
              <span class="chip ${escapeHtml(ev.cls)}">${escapeHtml(ev.result)}</span>
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
            <h2 style="margin:3px 0 4px;font-size:18px;font-weight:900;">${L('30 秒看懂 A9 涨价解锁', 'Understand A9 Price-Unlock in 30s')}</h2>
            <p class="num-xs text-sec" style="margin:0;">${L('70% 奖池 + 12% 团队全锁链上：涨不到目标价不解锁，永不爆仓，头矿 6H 仅 5% 止损。', '70% pool + 12% team locked on-chain: pump-to-unlock, no liquidation, First 6H 5% Stop-Loss.')}</p>
          </div>
          <span class="nt-art-badge tone-green" style="width:50px;height:50px;" aria-hidden="true">${renderNintendoGateIcon('rules', 32)}</span>
        </div>
      </div>

      <!-- 交互图解卡 1：头矿 6H 5% 止损 vs 普通 10% 止损 vs 提前解押 15% -->
      <section class="card rule-sim-card" id="rule-weight-sim">
        <div class="row-between">
          <div class="card-title">${icon('shieldCheck', 15, 'text-gold')} ${L('交互图解 · 止损与提前解押对比', 'Interactive · Stop-Loss & Early Exit')}</div>
          <span class="chip chip-gold mono">${L('全员 1:1 · 5× 封顶', '1:1 Fair · 5× Cap')}</span>
        </div>
        <div class="weight-fold-grid" role="group" aria-label="${L('选择进池时机', 'Select entry window')}">
          <button type="button" class="weight-fold-btn active" data-rule-weight="95" aria-pressed="true">
            <strong>-5%</strong>
            <small>${L('头矿 6H', 'First 6H')}</small>
          </button>
          <button type="button" class="weight-fold-btn" data-rule-weight="90" aria-pressed="false">
            <strong>-10%</strong>
            <small>${L('6H–24H', '6H–24H')}</small>
          </button>
          <button type="button" class="weight-fold-btn" data-rule-weight="85" aria-pressed="false">
            <strong>-15%</strong>
            <small>${L('提前解押', 'Early Exit')}</small>
          </button>
        </div>
        <div class="rule-verdict-box" id="rule-weight-output">
          <div class="row-between num-xs">
            <span class="text-sec">${L('假设锁仓 1,000 A9 未达标 / 解押', '1,000 A9 on fail / exit')}</span>
            <b class="mono text-green" id="rule-weight-val">${L('退回 950 A9（仅止损 50 A9 销毁）', 'Refund 950 A9 (50 A9 burned)')}</b>
          </div>
          <div class="num-xs text-muted" id="rule-weight-desc">${L('头矿前 6 小时锁仓享 5% 轻止损（退 95%）；通关后全员 1 A9 = 1 份公平分 7 亿奖池，绝不稀释。', 'First 6H locks get 5% Stop-Loss (95% refund); passing rounds split the 700,000,000 A9 pool 1:1 fairly.')}</div>
        </div>
      </section>

      <!-- 交互图解卡 2：12H 冲价 8/12 通关线推演滑杆 -->
      <section class="card rule-sim-card" id="rule-slot-sim">
        <div class="row-between">
          <div class="card-title">${icon('radar', 15, 'text-cyan')} ${L('交互图解 · 12H 冲价 8/12 通关线', 'Interactive · 12H Push (8/12 Goal)')}</div>
          <span class="chip chip-green mono" id="rule-slot-pill">8 / 12</span>
        </div>
        <div class="rule-range-wrap">
          <input class="rule-range-input" id="rule-slot-range" type="range" min="0" max="12" step="1" value="8" aria-label="${L('模拟达标时段数', 'Simulate qualified slots')}">
          <div class="row-between num-xs text-muted mono">
            <span>0</span>
            <span class="text-gold" style="font-weight:800;">★ 8 ${L('达标线', 'Goal')}</span>
            <span>12</span>
          </div>
        </div>
        <div class="rule-verdict-box pass" id="rule-slot-output">
          <div class="row-between num-xs">
            <b id="rule-slot-title" class="text-green">${L('冲价通关 ✓ · 全员 1:1 分奖池', 'Passed ✓ · 1:1 Pool Split')}</b>
            <span class="mono text-sec" id="rule-slot-sub">8 ≥ 8</span>
          </div>
          <div class="num-xs text-sec" id="rule-slot-desc">${L('通关立刻退 100% 本金 + 20% 秒提奖金，余下 80% 分 14 天逐秒解锁（每日 5.71%）；急用钱可随时走 3 折急提（7 折销毁）。', 'Pass refunds 100% principal + 20% instant reward; remaining 80% unlocks per second over 14 days (5.71%/day), with optional 30% Instant Cashout (70% burn).')}</div>
        </div>
      </section>

      <div class="card">
        <details class="faq-item" open>
          <summary><span>${L('1. 什么是「涨价解锁」和「头矿 6H · 5% 止损」？', '1. What is Price-Unlock & First 6H 5% Stop-Loss?')}</span><span class="faq-arrow">${icon('chevronDown', 15)}</span></summary>
          <div class="faq-body">
            ${L('全员 1 A9 = 1 份公平分 7 亿奖池（100 A9 起投，取消权重套路）。每轮 24H 锁仓期内，前 6 小时进池享 5% 轻止损（未通关退 95%），6 小时后进池享 10% 止损（未通关退 90%），永不爆仓归零！同地址前 6H 与 6H 后分账精确计算。', '1 A9 = 1 fair share of the 700,000,000 A9 pool (100 A9 min, no confusing weight multipliers). Lock in the First 6H for 5% Stop-Loss (95% refund on fail), or 10% Stop-Loss (90% refund) after 6H — zero liquidation.')}
          </div>
        </details>

        <details class="faq-item">
          <summary><span>${L('2. 24H 锁仓、提前解押与 12H 冲价怎么运转？', '2. How do 24H Lock, Early Exit & 12H Push work?')}</span><span class="faq-arrow">${icon('chevronDown', 15)}</span></summary>
          <div class="faq-body">
            ${L('24H 锁仓期内随时可发起「提前解押」：退回 85% 本金，扣 15% 直接进黑洞销毁。24H 到点自动封盘（禁进禁出，防巨鲸尾盘偷袭），进入 12H 冲价，只要有 ≥ 8/12 根 1H K 线站上目标价（首轮仅 +30%）即刻通关，单轮最高赚 5 倍币，未分完奖池 100% 滚入下轮。', 'During the 24H lock window you may Early Exit anytime (85% refunded, 15% burned). Once locked for the 12H Push, entry/exit pauses to block whale sniping; ≥ 8/12 hourly slots at target (+30% min) passes with a 5× cap (surplus rolls over 100%).')}
          </div>
        </details>

        <details class="faq-item">
          <summary><span>${L('3. 通关后 20% 秒提 + 14 天逐秒解锁与「3 折急提（7 折销毁）」怎么用？', '3. How do 20% Instant + 14D Per-Second Unlock & Instant Cashout work?')}</span><span class="faq-arrow">${icon('chevronDown', 15)}</span></summary>
          <div class="faq-body">
            ${L('通关即退 100% 本金 + 20% 秒提，余下 80% 分 14 天逐秒解锁（每日 5.71%，永久累计不倒扣）。若急用钱，任意一天可一键走「3 折急提（7 折销毁）」：已自然解锁部分按 100% 实发，仅对尚未解锁余额按 30% 立刻秒提、70% 永久销毁（满 14 天后误点也不销毁）。', 'Pass gives 100% principal + 20% Instant + 14D Per-Second Unlock (5.71%/day, never forfeited). Need cash fast? Instant Cashout (30% Now / 70% Burn) pays 100% of already-unlocked rewards + 30% of unvested balance immediately (70% burned; 0% burned after Day 14).')}
          </div>
        </details>

        <details class="faq-item">
          <summary><span>${L('4. 好友 8% 返佣 · 每轮空投与免费宝箱如何领取？', '4. How do 8% Referral Rebate · Round Airdrop & Free Chests work?')}</span><span class="faq-arrow">${icon('chevronDown', 15)}</span></summary>
          <div class="faq-body">
            ${L('新人 0 GRAM 可秒开青铜新手箱上车；拉好友锁仓通关享好友奖金 8% 额外返佣（18% 生态池出，不扣好友）+ 每轮等权空投抽奖，商城直推另享 6% 返佣。领取时付 0.06 GRAM 网络费由推广热钱包自动发 A9（当前只读验收阶段暂未开放真实领取）。', 'Claim a 0 GRAM Starter Chest to join; invite friends for 8% Referral Rebate · Round Airdrop (from ecosystem pool, zero cut from friends), plus 6% Chest Mall referrals. Payouts use the 0.06 GRAM hot wallet (currently disabled in read-only mode).')}
          </div>
        </details>
      </div>

      <button class="btn btn-secondary" data-nav="/risk/matrix">${icon('shieldAlert', 15)} ${L('查看 22 项链上风控保护', 'View 22 On-Chain Risk Guards')}</button>
    </div>
  `;

  // 绑定交互图解卡 1：止损档位切换
  const wVal = root.querySelector('#rule-weight-val');
  const wDesc = root.querySelector('#rule-weight-desc');
  root.querySelectorAll('[data-rule-weight]').forEach((btn) => {
    btn.onclick = () => {
      A9Haptic.tick();
      A9Audio.pageTurn();
      const refundPct = Number(btn.dataset.ruleWeight) || 90;
      const burnPct = 100 - refundPct;
      root.querySelectorAll('[data-rule-weight]').forEach((b) => {
        const on = b === btn;
        b.classList.toggle('active', on);
        b.setAttribute('aria-pressed', String(on));
      });
      if (wVal) {
        wVal.textContent = L(
          `退回 ${refundPct * 10} A9（仅销毁 ${burnPct * 10} A9）`,
          `Refund ${refundPct * 10} A9 (${burnPct * 10} A9 burned)`
        );
      }
      if (wDesc) {
        wDesc.textContent = refundPct === 95
          ? L('头矿前 6 小时锁仓享 5% 轻止损（退 95%）；通关后全员 1 A9 = 1 份公平分 7 亿奖池，绝不稀释。', 'First 6H locks get 5% Stop-Loss (95% refund); passing rounds split the 700,000,000 A9 pool 1:1 fairly.')
          : refundPct === 90
            ? L('6H–24H 普通锁仓享 10% 自动止损（退 90%），永不爆仓，留 90% 筹码继续冲下一轮。', '6H–24H locks get 10% Stop-Loss (90% refund), never liquidated.')
            : L('24H 锁仓期内随时可提前解押，退回 85% 本金、扣 15% 销毁；进入 12H 冲价后封盘禁出。', 'Early Exit inside 24H Lock refunds 85% and burns 15%; locked once 12H Push starts.');
      }
    };
  });

  // 绑定交互图解卡 2：12H 冲价 8/12 通关线滑杆
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
        if (v === 8) A9Audio.scaleChime(12);
        else A9Audio.ratchet(Math.max(1, Math.min(9, Math.ceil((v / 12) * 9))));
        prevSlot = v;
      }
      const pass = v >= 8;
      if (slotPill) {
        slotPill.textContent = `${v} / 12`;
        slotPill.className = `chip ${pass ? 'chip-green' : 'chip-red'} mono`;
      }
      if (slotOut) {
        slotOut.classList.toggle('pass', pass);
        slotOut.classList.toggle('burn', !pass);
      }
      if (slotTitle) {
        slotTitle.className = pass ? 'text-green' : 'text-red';
        slotTitle.textContent = pass
          ? L('冲价通关 ✓ · 全员 1:1 分奖池', 'Passed ✓ · 1:1 Pool Split')
          : L('未达 8/12 · 永不爆仓自动止损', 'Below 8/12 · Auto Stop-Loss');
      }
      if (slotSub) {
        slotSub.textContent = pass ? `${v} ≥ 8` : `${v} < 8（${L(`差 ${8 - v} 段`, `${8 - v} short`)}）`;
      }
      if (slotDesc) {
        slotDesc.textContent = pass
          ? L('通关立刻退 100% 本金 + 20% 秒提奖金，余下 80% 分 14 天逐秒解锁（每日 5.71%）；急用钱可随时走 3 折急提（7 折销毁）。', 'Pass refunds 100% principal + 20% instant reward; remaining 80% unlocks per second over 14 days (5.71%/day), with optional 30% Instant Cashout (70% burn).')
          : L('永不爆仓：未通关自动退回 95%（头矿 6H）/ 90%（普通）本金，仅销毁 5%/10% 止损 + 半数奖池，另一半奖池滚存下一轮。', 'No liquidation: auto-refunds 95% (First 6H) / 90% (late) principal, burning only 5%/10% stop-loss + half the round pool.');
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
