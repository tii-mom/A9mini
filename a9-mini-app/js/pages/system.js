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
import { renderCurrentRoute, getTheme, toggleTheme, applyHapticsPref, applyMotionPref } from '../app.js';
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
  { id: '11', code: 'ERR_0x2211_GAS_ESTIMATE_FAIL', cat: 'quota', titleZh: '智能合约领取 Gas 估算失败', titleEn: 'Claim Gas Estimation Failed', descZh: '普通领奖需附带 0.22 GRAM，提前解押/3 折急提需附带 0.34 GRAM，扣除链上费用和必要留存后退回可退余量。', descEn: 'Attach 0.22 GRAM for normal claim or 0.34 GRAM for Early Exit / Instant Cashout (excess refunded).', actionZh: '核对附带 Gas 重试', actionEn: 'Retry with Gas' },
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
  const hapticsOn = settings.hapticsEnabled !== false;
  const reducedMotionOn = Boolean(settings.reducedMotion);
  const isDemo = config.isDemo;
  const hasInitData = !isDemo && Boolean(A9TMA.getRawInitData());
  const seq = ++settingsRenderSeq;

  const tgRealUser = !isDemo && hasInitData ? (A9TMA.getUser?.() || null) : null;
  const tgVerifiedLive = !isDemo && hasInitData && user.tgBound;
  const tgStatusText = isDemo
    ? (user.tgBound ? L('已绑定', 'Bound') : L('去绑定', 'Bind'))
    : (tgVerifiedLive ? L('已核验', 'Verified') : L('待核验', 'Unverified'));
  const tgStatusCls = (isDemo ? user.tgBound : tgVerifiedLive) ? 'is-green' : 'is-amber';
  const tgSubText = isDemo
    ? (user.tgBound ? (user.username || '@demo') : L('宝箱商城与战队功能需绑定', 'Required for Chest Mall & Squad'))
    : (tgVerifiedLive
        ? (tgRealUser?.username || user.username || L('已通过 Telegram 安全身份核验', 'Verified via Telegram Mini App'))
        : L('请在 Telegram 小程序内打开自动核验', 'Open in Telegram Mini App to verify automatically'));

  const liveSettleActive = Boolean(hasInitData && liveNotifCache.fetched && liveNotifCache.settlementPush === true);
  const hourlySubText = isDemo
    ? L('12H 冲价每小时定盘达标实时提醒', 'Alert on each hourly 12H Push check')
    : L('个人整点推送暂未开放', 'Personal hourly push is unavailable');
  const settleSubText = isDemo
    ? L('轮次结算结果与金库可领通知', 'Notify when rounds settle or rewards unlock')
    : (!hasInitData
        ? L('请在 Telegram 小程序内打开以管理结算私聊提醒', 'Open in Telegram Mini App to manage settlement DM alerts')
        : (liveNotifCache.saving
            ? L('正在保存设置…', 'Saving preference…')
            : (liveNotifCache.error
                ? L('提醒状态同步失败，轻点右侧开关重试', 'Sync failed — tap the switch to retry')
                : (!liveNotifCache.fetched
                    ? L('正在同步服务端提醒状态…', 'Syncing alert preference…')
                    : (liveSettleActive
                        ? L('结算与领取提醒偏好已开启', 'Settlement & claim preference on')
                        : L('结算与领取提醒偏好已关闭', 'Settlement & claim preference off'))))));

  const isTestnet = (store.state.round?.protocolConfig?.network || config.network) === 'testnet';
  const envLabel = config.isDemo
    ? L('演示沙盒', 'DEMO SANDBOX')
    : isTestnet
      ? (store.fundsEnabled ? L('TON 测试网', 'TON TESTNET') : L('TON 测试网只读', 'TON TESTNET READ-ONLY'))
      : (store.fundsEnabled ? L('TON 主网', 'TON LIVE') : L('TON 主网只读', 'TON READ-ONLY'));

  root.innerHTML = `
    <div class="col-gap anim-page-enter">
      <div>
        <div class="sw-section-label">${L('提醒', 'Alerts')}</div>
        <div class="sw-menu-group">
          ${isDemo ? `<div class="sw-menu-row is-static">
            <span class="sw-row-icon is-amber" aria-hidden="true">${icon('bell', 16)}</span>
            <div class="sw-menu-left"><span class="sw-menu-title">${L('下轮开盘', 'Next Round Opening')}</span></div>
            <div class="a9-switch ${user.autoRenew ? 'on' : ''}" id="set-opening-demo" role="switch" aria-label="${L('下轮开盘', 'Next Round Opening')}" aria-checked="${Boolean(user.autoRenew)}" tabindex="0"></div>
          </div>` : ''}
          <div class="sw-menu-row is-static">
            <span class="sw-row-icon is-blue" aria-hidden="true">${icon('clock', 16)}</span>
            <div class="sw-menu-left">
              <span class="sw-menu-title">${L('整点冲价', 'Hourly Price Check')}</span>
              <span class="sw-menu-sub">${hourlySubText}</span>
            </div>
            <div class="sw-menu-right">
              ${isDemo
                ? `<div class="a9-switch ${settings.hourlyCandlePush ? 'on' : ''}" id="set-hourly-push-switch" aria-label="${L('整点冲价', 'Hourly price checks')}" data-pref="hourlyCandlePush" role="switch" aria-checked="${Boolean(settings.hourlyCandlePush)}" tabindex="0"></div>`
                : `<div class="a9-switch disabled" id="set-hourly-push-switch" role="switch" aria-checked="false" aria-disabled="true" aria-label="${L('整点冲价', 'Hourly price checks')}"></div>`}
            </div>
          </div>
          <div class="sw-menu-row is-static">
            <span class="sw-row-icon is-amber" aria-hidden="true">${icon('bell', 16)}</span>
            <div class="sw-menu-left">
              <span class="sw-menu-title">${L('结算与领取', 'Settlement & Claims')}</span>
              <span class="sw-menu-sub" id="set-settlement-push-sub">${settleSubText}</span>
            </div>
            <div class="sw-menu-right">
              ${isDemo
                ? `<div class="a9-switch ${settings.settlementPush ? 'on' : ''}" id="set-settlement-push-switch" aria-label="${L('结算与领取', 'Settlement and claims')}" data-pref="settlementPush" role="switch" aria-checked="${Boolean(settings.settlementPush)}" tabindex="0"></div>`
                : (!hasInitData
                    ? `<div class="a9-switch disabled" id="set-settlement-push-switch" aria-label="${L('结算与领取', 'Settlement and claims')}" role="switch" aria-checked="false" aria-disabled="true"></div>`
                    : `<div class="a9-switch ${liveSettleActive ? 'on' : ''}${liveNotifCache.saving ? ' disabled' : ''}" id="set-settlement-push-switch" aria-label="${L('结算与领取', 'Settlement and claims')}" role="switch" aria-checked="${liveSettleActive}" aria-disabled="${liveNotifCache.saving ? 'true' : 'false'}" tabindex="0"></div>`)}
            </div>
          </div>
        </div>
        <p class="num-xs text-sec" style="margin:8px 4px 0;">${isDemo
          ? L('演示设置仅在本地生效。', 'Demo preferences apply locally.')
          : L('结算开关保存你的偏好。实际通知取决于服务是否开放。', 'The switch saves your preference. Delivery depends on service availability.')}</p>
      </div>

      <div>
        <div class="sw-section-label">${L('外观与语言', 'Appearance & Language')}</div>
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

        <div class="sw-menu-group">
          <div class="sw-menu-row is-static">
            <span class="sw-row-icon is-blue" aria-hidden="true">${icon(soundOn ? 'volumeOn' : 'volumeOff', 16)}</span>
            <div class="sw-menu-left">
              <span class="sw-menu-title">${L('交互音效', 'Sound Effects')}</span>
              <span class="sw-menu-sub">${L('切页、盖章与确认操作时播放反馈音', 'Crisp chime feedback on tabs, stamps & confirms')}</span>
            </div>
            <div class="sw-menu-right">
              <div class="a9-switch ${soundOn ? 'on' : ''}" id="set-sound-switch" aria-label="${L('交互音效', 'Sound effects')}" role="switch" aria-checked="${soundOn}" tabindex="0"></div>
            </div>
          </div>
          <div class="sw-menu-row is-static">
            <span class="sw-row-icon is-green" aria-hidden="true">${icon('bolt', 16)}</span>
            <div class="sw-menu-left">
              <span class="sw-menu-title">${L('触感震动', 'Haptic Feedback')}</span>
              <span class="sw-menu-sub">${L('按键、滑块与结果确认时的轻震反馈', 'Tactile vibration on taps, sliders & results')}</span>
            </div>
            <div class="sw-menu-right">
              <div class="a9-switch ${hapticsOn ? 'on' : ''}" id="set-haptics-switch" aria-label="${L('触感震动', 'Haptic feedback')}" role="switch" aria-checked="${hapticsOn}" tabindex="0"></div>
            </div>
          </div>
          <div class="sw-menu-row is-static">
            <span class="sw-row-icon is-muted" aria-hidden="true">${icon('sliders', 16)}</span>
            <div class="sw-menu-left">
              <span class="sw-menu-title">${L('减弱动态效果', 'Reduce Motion')}</span>
              <span class="sw-menu-sub">${L('关闭开箱粒子、切页位移与脉冲动画', 'Disable chest particles, transitions & pulse animations')}</span>
            </div>
            <div class="sw-menu-right">
              <div class="a9-switch ${reducedMotionOn ? 'on' : ''}" id="set-reduced-motion-switch" aria-label="${L('减弱动态效果', 'Reduce motion')}" role="switch" aria-checked="${reducedMotionOn}" tabindex="0"></div>
            </div>
          </div>
          <button type="button" class="sw-menu-row" id="set-lang-row">
            <span class="sw-row-icon is-blue" aria-hidden="true">${icon('globe', 16)}</span>
            <div class="sw-menu-left">
              <span class="sw-menu-title">${L('界面语言', 'Language')}</span>
            </div>
            <div class="sw-menu-right">
              <span class="sw-menu-amount">${escapeHtml(curLangObj.label)}</span>
              <span class="sw-menu-arrow" aria-hidden="true">›</span>
            </div>
          </button>
        </div>
      </div>

      <div>
        <div class="sw-section-label">${L('账户与连接', 'Account & Connections')}</div>
        <div class="sw-menu-group">
          <button type="button" class="sw-menu-row" id="set-wallet-row">
            <span class="sw-row-icon is-red" aria-hidden="true">${icon('wallet', 16)}</span>
            <div class="sw-menu-left">
              <span class="sw-menu-title">${L('钱包管理', 'Manage Wallet')}</span>
              <span class="sw-menu-sub mono">${escapeHtml(user.connected ? (user.shortAddress || shortAddress(user.address) || user.address) : L('未连接 · TON Connect 2.0', 'Not connected · TON Connect 2.0'))}</span>
            </div>
            <div class="sw-menu-right">
              <span class="sw-menu-amount ${user.connected ? 'is-green' : 'is-amber'}">${user.connected ? L('已连接', 'Connected') : L('去连接', 'Connect')}</span>
              <span class="sw-menu-arrow" aria-hidden="true">›</span>
            </div>
          </button>
          <${isDemo ? 'button type="button" id="set-tg-row"' : 'div'} class="sw-menu-row${isDemo ? '' : ' is-static'}">
            <span class="sw-row-icon is-blue" aria-hidden="true">${icon('send', 16)}</span>
            <div class="sw-menu-left">
              <span class="sw-menu-title">${L('Telegram 身份核验', 'Telegram Identity')}</span>
              <span class="sw-menu-sub">${escapeHtml(tgSubText)}</span>
            </div>
            <div class="sw-menu-right">
              <span class="sw-menu-amount ${tgStatusCls}">${tgStatusText}</span>
              ${isDemo ? '<span class="sw-menu-arrow" aria-hidden="true">›</span>' : ''}
            </div>
          </${isDemo ? 'button' : 'div'}>
        </div>
      </div>

      <div>
        <div class="sw-section-label">${L('协议与帮助', 'Protocol & Help')}</div>
        <div class="sw-menu-group">
          <a class="sw-menu-row" href="#/rules">
            <span class="sw-row-icon is-red" aria-hidden="true">${icon('book', 16)}</span>
            <div class="sw-menu-left">
              <span class="sw-menu-title">${L('用户指南', 'User Guide')}</span>
              <span class="sw-menu-sub">${L('找宝箱、看冲价、领 A9', 'Chests, price checks and claiming A9')}</span>
            </div>
            <div class="sw-menu-right"><span class="sw-menu-arrow" aria-hidden="true">›</span></div>
          </a>
          <a class="sw-menu-row" href="#/risk/audit">
            <span class="sw-row-icon is-green" aria-hidden="true">${icon('shieldCheck', 16)}</span>
            <div class="sw-menu-left">
              <span class="sw-menu-title">${L('v17.0 链上验真', 'v17.0 On-Chain Audit')}</span>
              <span class="sw-menu-sub">${L('查看合约地址、逃生舱与链上参数', 'Inspect contracts, escape hatch & specs')}</span>
            </div>
            <div class="sw-menu-right"><span class="sw-menu-arrow" aria-hidden="true">›</span></div>
          </a>
          <a class="sw-menu-row" href="#/risk/matrix">
            <span class="sw-row-icon is-amber" aria-hidden="true">${icon('shieldAlert', 16)}</span>
            <div class="sw-menu-left">
              <span class="sw-menu-title">${L('安全护盾', 'Safety Shield')}</span>
              <span class="sw-menu-sub">${L('22 种链上风控与异常保护参考手册', '22-state on-chain protection reference')}</span>
            </div>
            <div class="sw-menu-right"><span class="sw-menu-arrow" aria-hidden="true">›</span></div>
          </a>
          <a class="sw-menu-row" href="./privacy.html">
            <span class="sw-row-icon is-muted" aria-hidden="true">${icon('shield', 16)}</span>
            <div class="sw-menu-left"><span class="sw-menu-title">${L('隐私政策', 'Privacy Policy')}</span></div>
            <span class="sw-menu-arrow" aria-hidden="true">›</span>
          </a>
          <a class="sw-menu-row" href="./terms.html">
            <span class="sw-row-icon is-muted" aria-hidden="true">${icon('receipt', 16)}</span>
            <div class="sw-menu-left"><span class="sw-menu-title">${L('使用条款', 'Terms of Use')}</span></div>
            <span class="sw-menu-arrow" aria-hidden="true">›</span>
          </a>
        </div>
      </div>

      ${config.isDemo ? `<button class="btn btn-danger" id="btn-reset-demo" type="button">${icon('refresh', 15)} ${L('重置本地演示数据', 'Reset Demo Data')}</button>` : ''}

      <div>
        <div class="sw-section-label">${L('关于 A9', 'About A9')}</div>
        <section class="card sw-about-card">
          <div class="row-start" style="gap:12px;">
            <span class="sw-about-logo" aria-hidden="true"><img src="./assets/brand/apple-touch-icon.png" width="40" height="40" alt="A9" decoding="async" /></span>
            <div style="min-width:0;">
              <strong style="font-size:15px;font-weight:900;display:block;line-height:1.25;">${L('A9 · 财富大冒险', 'A9 · Wealth Quest')}</strong>
              <p class="num-xs text-sec" style="margin:3px 0 0;line-height:1.4;">${L('基于 TON 的非托管涨价解锁应用', 'Non-custodial Price-Unlock app on TON')}</p>
            </div>
          </div>
          <div class="grid-2" style="gap:8px;margin-top:11px;">
            <button type="button" class="btn btn-secondary btn-sm" id="set-open-web" style="width:100%;min-height:38px;">${icon('globe', 13)} ${L('官网 a9.lat', 'Website')}</button>
            <button type="button" class="btn btn-secondary btn-sm" id="set-open-x" style="width:100%;min-height:38px;">${icon('xBrand', 13)} @A9_Ton</button>
          </div>
        </section>
      </div>
      <div class="settings-version-strip">
        <span>A9 Protocol · ${PROTOCOL_SPECS.version}</span>
        <span>${escapeHtml(envLabel)}</span>
      </div>
    </div>
  `;

  root.querySelectorAll('[data-pick-theme]').forEach((btn) => {
    btn.onclick = (e) => {
      const target = btn.dataset.pickTheme;
      if (target === getTheme()) return;
      const next = toggleTheme(e);
      showToast(next === 'dark' ? L('已切换石墨暗夜主题', 'Switched to Switch Dark') : L('已切换雪白亮色主题', 'Switched to Crisp Light'));
    };
  });

  const walletRow = root.querySelector('#set-wallet-row');
  if (walletRow) walletRow.onclick = () => tonConnect.openConnectModal(renderCurrentRoute);
  const openWebBtn = root.querySelector('#set-open-web');
  if (openWebBtn) {
    openWebBtn.onclick = () => {
      A9Haptic.light();
      A9TMA.openExternalLink('https://a9.lat');
    };
  }
  const openXBtn = root.querySelector('#set-open-x');
  if (openXBtn) {
    openXBtn.onclick = () => {
      A9Haptic.light();
      A9TMA.openExternalLink('https://x.com/A9_Ton');
    };
  }
  const tgRow = root.querySelector('#set-tg-row');
  if (tgRow) {
    tgRow.onclick = () => {
      A9Haptic.success();
      store.update(s => { s.user.tgBound = !s.user.tgBound; });
      showToast(store.state.user.tgBound ? L('Telegram 已绑定', 'Telegram bound') : L('已模拟解绑 Telegram', 'Telegram unbound'));
      renderSettingsPage(root);
      try { root.querySelector('#set-tg-row')?.focus?.({ preventScroll: true }); } catch (_) {}
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
      soundSw.classList.toggle('on', on);
      soundSw.setAttribute('aria-checked', String(on));
      showToast(on ? L('触感交互音效已开启', 'Tactile UI Sound On') : L('交互音效已静音', 'Sound Muted'));
    };
    soundSw.onclick = toggleSound;
    soundSw.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleSound(); } };
  }
  const hapticsSw = root.querySelector('#set-haptics-switch');
  if (hapticsSw) {
    const toggleHaptics = () => {
      const next = applyHapticsPref(!(store.state.settings.hapticsEnabled !== false));
      hapticsSw.classList.toggle('on', next);
      hapticsSw.setAttribute('aria-checked', String(next));
      if (next) A9Haptic.light();
      showToast(next ? L('触感震动已开启', 'Haptic Feedback On') : L('触感震动已关闭', 'Haptic Feedback Off'));
    };
    hapticsSw.onclick = toggleHaptics;
    hapticsSw.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleHaptics(); } };
  }
  const motionSw = root.querySelector('#set-reduced-motion-switch');
  if (motionSw) {
    const toggleMotion = () => {
      A9Haptic.light();
      const next = applyMotionPref(!store.state.settings.reducedMotion);
      motionSw.classList.toggle('on', next);
      motionSw.setAttribute('aria-checked', String(next));
      showToast(next ? L('已开启减弱动态效果', 'Reduce Motion On') : L('已恢复标准动态效果', 'Standard Motion Restored'));
    };
    motionSw.onclick = toggleMotion;
    motionSw.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleMotion(); } };
  }
  if (isDemo) {
    const opening = root.querySelector('#set-opening-demo');
    if (opening) {
      const toggleOpening = () => {
        A9Haptic.tick();
        store.update(state => { state.user.autoRenew = !state.user.autoRenew; });
        opening.setAttribute('aria-checked', String(store.state.user.autoRenew));
        opening.classList.toggle('on', store.state.user.autoRenew);
      };
      opening.onclick = toggleOpening;
      opening.onkeydown = event => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          toggleOpening();
        }
      };
    }
    root.querySelectorAll('[data-pref]').forEach(el => {
      const togglePref = () => {
        A9Haptic.tick();
        const k = el.dataset.pref;
        const next = !store.state.settings[k];
        store.update(s => { s.settings[k] = next; });
        el.classList.toggle('on', next);
        el.setAttribute('aria-checked', String(next));
      };
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
            ? L('结算与领取提醒偏好已开启', 'Settlement & claim preference on')
            : L('结算与领取提醒偏好已关闭', 'Settlement & claim preference off');
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
  const isDemo = config.isDemo;
  let filter = 'all';
  const render = () => {
    const list = filter === 'all' ? RISK_STATES : RISK_STATES.filter(x => x.cat === filter);
    root.innerHTML = `
      <div class="col-gap anim-page-enter">
        <div class="card card-glow-red">
          <div class="row-between">
            <div>
              <div class="caps text-red">${isDemo ? 'SENTINEL ENGINE · DEMO' : 'v17.0 SAFETY REFERENCE'}</div>
              <div style="font-size:16px;font-weight:700;margin-top:2px;">${L('22 种链上风控与异常保护手册', '22-State On-Chain Risk Reference')}</div>
            </div>
            <span class="chip chip-green">22/22</span>
          </div>
          <div class="num-xs text-sec" style="margin-top:6px;">${isDemo
            ? L('点击任意异常卡片可触发对应的风控拦截弹窗模拟', 'Tap any guard card to simulate its circuit-breaker modal')
            : L('只读规则参考：完整列出协议 22 种链上保护与处理指引，不触发模拟弹窗。', 'Read-only reference: all 22 on-chain guard states and recovery guidance (simulations disabled in live mode).')}</div>
        </div>

        <div class="seg-tabs">
          <button class="seg-tab ${filter === 'all' ? 'active' : ''}" data-rf="all" type="button">${L('全部 22', 'All 22')}</button>
          <button class="seg-tab ${filter === 'wallet' ? 'active' : ''}" data-rf="wallet" type="button">${L('钱包/链', 'Wallet')}</button>
          <button class="seg-tab ${filter === 'quota' ? 'active' : ''}" data-rf="quota" type="button">${L('轮次/冲价', 'Round')}</button>
          <button class="seg-tab ${filter === 'market' ? 'active' : ''}" data-rf="market" type="button">${L('宝箱商城', 'Mall')}</button>
          <button class="seg-tab ${filter === 'team' ? 'active' : ''}" data-rf="team" type="button">${L('战队', 'Squad')}</button>
        </div>

        <div class="col-gap">
          ${list.map(item => `
            <div class="card ${isDemo ? 'clickable' : ''}" ${isDemo ? `role="button" tabindex="0" data-sim-err="${item.id}" style="cursor:pointer;"` : ''}>
              <div class="row-between" style="margin-bottom:4px;">
                <span class="num-xs text-red mono">#${item.id} ${item.code}</span>
                ${isDemo
                  ? `<span class="chip chip-amber">${L('模拟拦截', 'Simulate')}</span>`
                  : `<span class="chip chip-muted">${L('规则参考', 'Reference')}</span>`}
              </div>
              <div style="font-weight:700;font-size:13px;">${L(item.titleZh, item.titleEn)}</div>
              <div class="text-sec" style="font-size:11.5px;margin-top:3px;line-height:1.45;">${L(item.descZh, item.descEn)}</div>
              ${!isDemo ? `<div class="num-xs text-muted" style="margin-top:5px;">${L('建议处理', 'Guidance')}: ${L(item.actionZh, item.actionEn)}</div>` : ''}
            </div>
          `).join('')}
        </div>

        <div class="sw-menu-group">
          <a class="sw-menu-row" href="#/risk/audit">
            <div class="sw-menu-left"><span class="sw-menu-title">${L('v17.0 链上防 Rug 验真', 'v17.0 On-Chain Audit')}</span></div>
            <div class="sw-menu-right"><span class="sw-menu-arrow" aria-hidden="true">›</span></div>
          </a>
          <a class="sw-menu-row" href="#/rules">
            <div class="sw-menu-left"><span class="sw-menu-title">${L('返回闯关指南', 'Back to Guide')}</span></div>
            <div class="sw-menu-right"><span class="sw-menu-arrow" aria-hidden="true">›</span></div>
          </a>
          <a class="sw-menu-row" href="#/settings">
            <div class="sw-menu-left"><span class="sw-menu-title">${L('返回提醒与设置', 'Back to Settings')}</span></div>
            <div class="sw-menu-right"><span class="sw-menu-arrow" aria-hidden="true">›</span></div>
          </a>
        </div>
      </div>
    `;

    root.querySelectorAll('[data-rf]').forEach(b => {
      b.onclick = () => { A9Haptic.light(); filter = b.dataset.rf; render(); };
    });

    if (isDemo) {
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
    }
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
  const isDemo = config.isDemo;
  const hasContractAddr = Boolean(rcAddr);
  const adminRenounced = typeof contracts.adminRenounced === 'boolean'
    ? contracts.adminRenounced
    : (typeof cfg.adminRenounced === 'boolean' ? cfg.adminRenounced : null);
  const verifiedOnchain = !isDemo && hasContractAddr && (Boolean(round?.poolState?.dataAvailable) || adminRenounced === true);

  const formatSyncTime = (ts) => {
    const n = Number(ts);
    if (!Number.isFinite(n) || n <= 0) return L('待同步', 'Pending sync');
    const ms = n > 1e12 ? n : n * 1000;
    const d = new Date(ms);
    if (Number.isNaN(d.getTime())) return L('待同步', 'Pending sync');
    const pad = (x) => String(x).padStart(2, '0');
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
  };
  const lastSyncedLabel = isDemo
    ? L('演示数据', 'Demo Sandbox')
    : formatSyncTime(round?.lastSyncedAt || round?.updatedAt || round?.syncedAt || cfg?.syncedAt || null);

  const badgeHtml = isDemo
    ? `<span class="chip chip-muted">DEMO · v17.0</span>`
    : verifiedOnchain
      ? `<span class="chip chip-green">${escapeHtml(String(network || 'mainnet').toUpperCase())} · v17.0</span>`
      : `<span class="chip chip-amber">${L('待核验', 'Pending Verification')}</span>`;

  const adminHtml = isDemo || adminRenounced === true
    ? `<span class="mono text-green" style="font-weight:800;">addr_none · ${L('已弃权', 'Renounced')}</span>`
    : adminRenounced === false
      ? `<span class="mono num-xs text-amber">${L('尚未弃权（链上仍存在 admin）', 'Not yet renounced (admin present)')}</span>`
      : (hasContractAddr || Boolean(jettonAddr))
        ? `<span class="mono num-xs text-muted">${L('待链上验真（Tonviewer 查验 addr_none）', 'Pending check (verify addr_none on Tonviewer)')}</span>`
        : `<span class="mono num-xs text-muted">${L('待核验（主网部署后按 addr_none 验真）', 'Pending verification (addr_none after deploy)')}</span>`;

  const hasPoolRem = poolRemA9 !== null && poolRemA9 !== undefined && Number.isFinite(Number(poolRemA9));

  const invariantsBoardHtml = `
    <section class="card card-hero" id="v16-invariants-board">
      <div class="row-between" style="margin-bottom:8px;">
        <div class="card-title">${icon('shieldCheck', 16, hasContractAddr || isDemo ? 'text-green' : 'text-gold')} ${L('v17.0 链上防 Rug 安全不变量看板', 'v17.0 On-Chain Security Invariants')}</div>
        ${badgeHtml}
      </div>
      <div class="check-list">
        <div class="check-row">
          <span class="text-sec">${L('管理员权限（admin_address）', 'Admin Address')}</span>
          ${adminHtml}
        </div>
        <div class="check-row">
          <span class="text-sec">${L('无许可逃生舱（AbortRound）', 'Permissionless Escape Hatch')}</span>
          <span class="mono" style="font-weight:700;">${L('7 天异常可全员退本', '7d AbortRound Refund')}</span>
        </div>
        <div class="check-row">
          <span class="text-sec">${L('链上剩余奖池（poolRemaining）', 'On-Chain Pool Remaining')}</span>
          <span class="mono ${hasPoolRem ? 'text-green' : 'text-muted'}" style="font-weight:800;">${hasPoolRem ? `${formatNum(Math.round(Number(poolRemA9)))} A9` : L('待同步', 'Pending sync')}</span>
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
          <span class="text-sec">${L('核验网络', 'Network')}</span>
          <span class="mono num-xs">${escapeHtml(String(network || 'mainnet'))}</span>
        </div>
        <div class="check-row">
          <span class="text-sec">${L('最近同步时间', 'Last Synced')}</span>
          <span class="mono num-xs">${escapeHtml(lastSyncedLabel)}</span>
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
          : `<a class="btn btn-secondary btn-sm" href="#/rules">${icon('book', 13)} ${L('查看用户指南', 'View User Guide')}</a>
             <a class="btn btn-secondary btn-sm" href="#/challenge">${icon('arrowLeft', 13)} ${L('返回广场', 'Back to Plaza')}</a>`}
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
            <span class="chip ${hasContractAddr ? 'chip-muted' : 'chip-amber'}">${hasContractAddr ? L('链上同步中', 'SYNCING') : L('待部署核验', 'PENDING DEPLOY')}</span>
          </div>
          <p class="num-xs text-sec" style="margin:0;line-height:1.5;">${hasContractAddr
            ? L('每小时 1H TWAP 定盘与轮次结算哈希将在链上出块后自动归档展示；上方 v17.0 合约地址与不可变安全参数可在 Tonviewer 直查核验。', 'Hourly TWAP seals and round settlement hashes archive here as blocks finalize; verify live contract state directly on Tonviewer above.')
            : L('主网合约地址尚未注入，上方仅展示 v17.0 协议设计规格；主网部署并注入合约地址后即可直查链上不变量与事件流。', 'Mainnet contract addresses are not yet configured. Above reflects v17.0 protocol specifications; live invariants and event streams activate once contracts are deployed.')}</p>
        </section>
        <div class="sw-menu-group">
          <a class="sw-menu-row" href="#/challenge">
            <div class="sw-menu-left"><span class="sw-menu-title">${L('返回广场', 'Back to Plaza')}</span></div>
            <div class="sw-menu-right"><span class="sw-menu-arrow" aria-hidden="true">›</span></div>
          </a>
          <a class="sw-menu-row" href="#/settings">
            <div class="sw-menu-left"><span class="sw-menu-title">${L('返回提醒与设置', 'Back to Settings')}</span></div>
            <div class="sw-menu-right"><span class="sw-menu-arrow" aria-hidden="true">›</span></div>
          </a>
        </div>
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

export function renderNotFoundPage(root) {
  root.innerHTML = `
    <div class="col-gap anim-page-enter">
      <div class="card empty-state">
        <div class="icon-badge red" style="width:46px;height:46px;border-radius:13px;">${icon('shieldAlert', 22)}</div>
        <div class="num-xl" style="margin-top:4px;">404</div>
        <div class="text-sec" style="font-size:12px;">${L('该页面不存在或路由链接已失效', 'This page was not found or the link has expired')}</div>
        <button class="btn btn-primary btn-sm" style="margin-top:8px;" data-nav="/challenge">${icon('arrowLeft', 14)} ${L('返回 A9 广场', 'Back to Plaza')}</button>
      </div>
      <div class="sw-menu-group">
        <a class="sw-menu-row" href="#/round">
          <div class="sw-menu-left"><span class="sw-menu-title">${L('进入闯关战场', 'Enter Quest Arena')}</span></div>
          <div class="sw-menu-right"><span class="sw-menu-arrow" aria-hidden="true">›</span></div>
        </a>
        <a class="sw-menu-row" href="#/internal/market">
          <div class="sw-menu-left"><span class="sw-menu-title">${L('前往宝箱商城', 'Go to Chest Mall')}</span></div>
          <div class="sw-menu-right"><span class="sw-menu-arrow" aria-hidden="true">›</span></div>
        </a>
      </div>
    </div>
  `;
}
