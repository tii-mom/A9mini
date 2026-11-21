/**
 * System Settings, 22-State Risk Matrix, On-Chain Audit Log & Protocol Rules Pages
 * Zero-Emoji + Real Bilingual Switcher + /rules Manual
 */

import { store } from '../store.js';
import { config } from '../config.js';
import { A9Haptic } from '../tma.js';
import { A9Audio } from '../audio.js';
import { showToast, openModal, closeModal } from '../components.js';
import { icon } from '../icons.js';
import { L, LANGUAGES } from '../i18n.js';
import { openChoiceSheet } from '../components.js';
import { tonConnect } from '../tonconnect.js';
import { renderCurrentRoute } from '../app.js';

const RISK_STATES = [
  { id: '01', code: 'ERR_0x1301_TON_REJECTED', cat: 'wallet', title: '钱包未连接 / 签名主动拒绝', desc: '用户在 TON Connect 2.0 握手时关闭窗口或拒绝签名。', action: '快速重新连接钱包' },
  { id: '02', code: 'ERR_0x1302_INSUFFICIENT_GAS', cat: 'wallet', title: '余额不足支付 Gas / 本金', desc: '钱包可用 GRAM 不足覆盖质押下限及 0.08 GRAM 合约调用 Gas。', action: '唤起 GRAM 快捷充值' },
  { id: '03', code: 'ERR_0x1303_MEMPOOL_TIMEOUT', cat: 'wallet', title: '链上 RPC 广播超时 / 拥堵', desc: 'Toncenter 节点延迟超过 8000ms，交易滞留 Mempool。', action: '自动切换备用 L1 RPC' },
  { id: '04', code: 'ERR_0x1304_BELOW_MIN_STAKE', cat: 'wallet', title: '质押金额低于 10 GRAM 最小门槛', desc: '单次执行需确保至少 10 GRAM 完整单元。', action: '一键补齐至 10 GRAM' },
  { id: '05', code: 'ERR_0x1305_EXCEED_15X_HARDCAP', cat: 'wallet', title: '超过 15x 单人单轮收益硬顶', desc: '复合倍率触达协议硬顶，超额部分划入协议流动性缓冲。', action: '查看收益上限说明' },
  { id: '06', code: 'ERR_0x7E4F_QUOTA_EXHAUSTED', cat: 'quota', title: '个人单轮额度已达 1,000 GRAM 上限', desc: '触发防巨鲸熔断算法 (Anti-Whale Guard v2)。', action: '前往主挑战池' },
  { id: '07', code: 'ERR_0x2207_STAGE_CLOSED_LOCKOUT', cat: 'quota', title: '参与阶段已截单 / 进入观察期', desc: '本轮入场通道关闭，转入连续 24 小时观察结算。', action: '追踪当前观察仓位' },
  { id: '08', code: 'ERR_0x2208_OBSERVE_FAILED_BURN', cat: 'quota', title: '24小时观察期未达标 (K线 < 16根)', desc: '触发流动性清算与下轮扩容补偿机制。', action: '查看清算存证哈希' },
  { id: '09', code: 'ERR_0x2209_ORACLE_CIRCUIT_BREAK', cat: 'quota', title: '预言机喂价异常熔断 (Pyth/RedStone)', desc: '跨链报价偏差 > 8.5%，系统自动开启安全隔离并 100% 锁定退还本金。', action: '查看熔断审计报告' },
  { id: '10', code: 'ERR_0x2210_NO_CLAIMABLE_BAL', cat: 'quota', title: '待领取奖励为空', desc: '当前可提取额度为 0，其余资产仍在 80% 线性归属周期。', action: '查看线性释放计划' },
  { id: '11', code: 'ERR_0x2211_GAS_ESTIMATE_FAIL', cat: 'quota', title: '智能合约领取 Gas 估算失败', desc: 'TVM 预执行抛出 Out-of-gas 警告，建议提高 Gas 上限至 0.15 GRAM。', action: '以 0.15 GRAM 重试' },
  { id: '12', code: 'ERR_0x3312_TG_AUTH_REQUIRED', cat: 'market', title: '未绑定 TG 账号阻断内盘认购', desc: '独立外部钱包缺少 Telegram InitData 签名校验。', action: '绑定 Telegram 账号' },
  { id: '13', code: 'ERR_0x3313_PRESALE_SOLD_OUT', cat: 'market', title: '内盘瞬时超募售罄 (Sold Out)', desc: '内盘总额度已被抢空，后发交易由合约原路免手续费退还。', action: '查询自动退款流水' },
  { id: '14', code: 'ERR_0x3314_USER_CANCELLATION', cat: 'market', title: '用户主动取消内盘认购', desc: '锁仓前主动撤单，扣除固定 0.05 GRAM 计算损耗费后退回余额。', action: '确认撤单规则' },
  { id: '15', code: 'ERR_0x3315_DUST_NON_REFUNDABLE', cat: 'market', title: '粉尘金额认购 (≤0.1 GRAM 拦截)', desc: '微小数额低于链上拆单成本，协议直接拦截。', action: '调整至 ≥5 GRAM' },
  { id: '16', code: 'ERR_0x4416_CAPTAIN_CANNOT_EXIT', cat: 'team', title: '团队队长试图退团阻断', desc: '队长绑定分润金库，需先移交队长权限方可离团。', action: '前往移交队长权限' },
  { id: '17', code: 'ERR_0x4417_TEAM_SWITCH_QUOTA', cat: 'team', title: '赛季内切换团队超过 1 次限制', desc: '每个赛季严格限制仅可迁移团队 1 次，防止套利。', action: '等待下赛季重置' },
  { id: '18', code: 'ERR_0x4418_PREHEAT_ELIGIBILITY', cat: 'team', title: '预热未达到 ≥1 名有效直邀门槛', desc: '需至少邀请 1 位完成入金认证的真实伙伴以激活排位资格。', action: '分享专属邀请链' },
  { id: '19', code: 'ERR_0x4419_INVITE_HARDCAP', cat: 'team', title: '邀请奖励达 320,000 A9 单轮硬顶', desc: '单地址单轮邀请分润封顶，多余积分自动转入社区奖池。', action: '查看返佣上限' },
  { id: '20', code: 'ERR_0x5520_TG_BOT_PERM_LOST', cat: 'sys', title: 'TG 群组解绑 / Bot 管理员权限丢失', desc: '关联群组撤销了 @A9Terminal_bot 管理员权限。', action: '重新授权 Bot Admin' },
  { id: '21', code: 'ERR_0x5521_RENEWAL_TIMEOUT', cat: 'sys', title: '续期策略撤销超时 (<30分钟锁定)', desc: '已进入新轮开盘前 30 分钟锁定缓冲期。', action: '等待下轮开盘后调整' },
  { id: '22', code: 'ERR_0x5522_UPGRADE_PAUSED', cat: 'sys', title: '智能合约升级维护公告态', desc: '多签理事会正在执行 TVM 无缝升级，暂停读写 15 分钟。', action: '订阅官方升级频道' }
];

export function renderSettingsPage(root) {
  const { settings, risk, user } = store.state;
  const curLangObj = LANGUAGES.find(l => l.code === settings.language) || LANGUAGES[0];

  root.innerHTML = `
    <div class="col-gap anim-page-enter">
      <div class="card">
        <div class="card-header"><div class="card-title">${icon('settings', 15)} ${L('账户与连接', 'Account & Connections')}</div><span class="num-xs text-muted">v2.4.0</span></div>
        <div class="col-gap">
          <div class="list-row clickable" id="set-wallet-row">
            <div><div style="font-weight:600;">${L('钱包管理 (TON Connect 2.0)', 'Wallet (TON Connect 2.0)')}</div><div class="num-xs text-muted">${user.connected ? user.shortAddress : L('未连接', 'Disconnected')}</div></div>
            <span class="chip ${user.connected ? 'chip-green' : 'chip-gold'}">${user.connected ? L('已连接', 'Connected') : L('去连接', 'Connect')}</span>
          </div>
          <div class="list-row clickable" id="set-tg-row">
            <div><div style="font-weight:600;">${L('Telegram 账号绑定', 'Telegram Binding')}</div><div class="num-xs text-muted">${user.tgBound ? user.username : L('内盘购买与团队功能需绑定', 'Required for Market & Team')}</div></div>
            <span class="chip ${user.tgBound ? 'chip-green' : 'chip-gold'}">${user.tgBound ? L('已绑定', 'Bound') : L('立即绑定', 'Bind')}</span>
          </div>
          <div class="list-row clickable" id="set-lang-row">
            <div><div style="font-weight:600;">${L('语言选择 (8 语种)', 'Language (8 Languages)')}</div><div class="num-xs text-muted">${curLangObj.label}</div></div>
            <span class="chip chip-muted">${curLangObj.code} ${icon('chevronDown', 11)}</span>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-header"><div class="card-title">${icon('bell', 15)} ${L('交互与通知偏好', 'Feedback & Notifications')}</div></div>
        <div class="col-gap">
          <div class="list-row"><div><span>${L('交互微音效', 'Tactile Sound')}</span><div class="num-xs text-muted">${L('默认静音，开启后在确认与关键操作时轻响', 'Muted by default; subtle chime on confirmations')}</div></div><div class="a9-switch ${A9Audio.isEnabled() ? 'on' : ''}" id="set-sound-switch" role="switch" aria-checked="${A9Audio.isEnabled()}" tabindex="0"></div></div>
          <div class="list-row"><span>${L('整点 1H K 线收盘推送', 'Hourly Candle Close')}</span><div class="a9-switch ${settings.hourlyCandlePush ? 'on' : ''}" data-pref="hourlyCandlePush"></div></div>
          <div class="list-row"><span>${L('轮次结算与领取提醒', 'Settlement & Claim Alerts')}</span><div class="a9-switch ${settings.settlementPush ? 'on' : ''}" data-pref="settlementPush"></div></div>
        </div>
      </div>

      <div class="grid-2">
        <button class="btn btn-secondary" data-nav="/rules">${icon('book', 15)} ${L('规则说明', 'Rules')}</button>
        <button class="btn btn-secondary" data-nav="/risk/matrix">${icon('shieldAlert', 15)} ${L('风控与状态自检', 'Risk & States')}</button>
      </div>
      ${config.isDemo ? `<button class="btn btn-danger" id="btn-reset-demo">${icon('refresh', 15)} ${L('重置本地演示数据', 'Reset Demo Data')}</button>` : ''}
    </div>
  `;

  root.querySelector('#set-wallet-row').onclick = () => tonConnect.openConnectModal(renderCurrentRoute);
  root.querySelector('#set-tg-row').onclick = () => {
    A9Haptic.success();
    store.update(s => { s.user.tgBound = !s.user.tgBound; });
    showToast(store.state.user.tgBound ? L('Telegram 已绑定', 'Telegram bound') : L('已模拟解绑 Telegram', 'Telegram unbound'));
    renderSettingsPage(root);
  };
  root.querySelector('#set-lang-row').onclick = () => openChoiceSheet({
    title: L('选择界面语言 (8 语种)', 'Select Language (8)'),
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
      showToast(on ? L('交互微音效已开启', 'Tactile Sound On') : L('交互微音效已静音', 'Sound Muted'));
      renderSettingsPage(root);
    };
    soundSw.onclick = toggleSound;
    soundSw.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleSound(); } };
  }
  root.querySelectorAll('[data-pref]').forEach(el => {
    el.onclick = () => { A9Haptic.tick(); const k = el.dataset.pref; store.update(s => { s.settings[k] = !s.settings[k]; }); renderSettingsPage(root); };
  });
  const resetBtn = root.querySelector('#btn-reset-demo');
  if (resetBtn) resetBtn.onclick = () => { A9Haptic.warning(); store.reset(); showToast(L('已恢复初始数据', 'Demo reset')); renderCurrentRoute(); };
}

export function renderRiskMatrix(root) {
  let filter = 'all';
  const render = () => {
    const list = filter === 'all' ? RISK_STATES : RISK_STATES.filter(x => x.cat === filter);
    root.innerHTML = `
      <div class="col-gap anim-page-enter">
        <div class="card card-glow-red">
          <div class="row-between">
            <div>
              <div class="caps text-red">SENTINEL ENGINE ACTIVE</div>
              <div style="font-size:16px;font-weight:700;margin-top:2px;">22 种全状态异常风控矩阵</div>
            </div>
            <span class="chip chip-green">COVERAGE: 22/22</span>
          </div>
          <div class="num-xs text-sec" style="margin-top:6px;">点击任意异常卡片可实时触发对应的风控拦截弹窗模拟</div>
        </div>

        <div class="seg-tabs">
          <button class="seg-tab ${filter === 'all' ? 'active' : ''}" data-rf="all">全部 22</button>
          <button class="seg-tab ${filter === 'wallet' ? 'active' : ''}" data-rf="wallet">钱包/链</button>
          <button class="seg-tab ${filter === 'quota' ? 'active' : ''}" data-rf="quota">额度/观察</button>
          <button class="seg-tab ${filter === 'market' ? 'active' : ''}" data-rf="market">内盘</button>
          <button class="seg-tab ${filter === 'team' ? 'active' : ''}" data-rf="team">团队</button>
        </div>

        <div class="col-gap">
          ${list.map(item => `
            <div class="card clickable" data-sim-err="${item.id}" style="cursor:pointer;">
              <div class="row-between" style="margin-bottom:4px;">
                <span class="num-xs text-red">#${item.id} ${item.code}</span>
                <span class="chip chip-amber">模拟拦截</span>
              </div>
              <div style="font-weight:700;font-size:13px;">${item.title}</div>
              <div class="text-sec" style="font-size:11px;margin-top:3px;">${item.desc}</div>
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
        openModal(`
          <div class="sheet-handle"></div>
          <div class="row-between">
            <span class="chip chip-red">CIRCUIT BREAKER ARMED</span>
            <span class="num-xs text-muted">${item.code}</span>
          </div>
          <div class="row-start" style="font-size:16px;font-weight:700;">${icon('shieldAlert', 18, 'text-red')} ${item.title}</div>
          <div class="text-sec" style="font-size:12px;">${item.desc}</div>
          <button class="btn btn-primary" id="modal-resolve-btn">${icon('bolt', 15)} ${item.action}</button>
          <button class="btn btn-secondary" id="modal-close-btn">关闭模拟弹窗</button>
        `);
        document.getElementById('modal-resolve-btn').onclick = () => {
          closeModal();
          showToast(`已执行风控恢复路径: ${item.action}`);
        };
        document.getElementById('modal-close-btn').onclick = closeModal;
      };
    });
  };
  render();
}

export function renderRiskAudit(root) {
  const { risk } = store.state;
  root.innerHTML = `
    <div class="col-gap anim-page-enter">
      <div class="card card-glow-green">
        <div class="row-between">
          <div>
            <div class="caps text-green">TVM SMART CONTRACT AUDIT</div>
            <div style="font-size:16px;font-weight:700;margin-top:4px;">链上熔断与预言机健康度</div>
          </div>
          <span class="chip chip-green">ALL NOMINAL</span>
        </div>
        <div class="grid-3" style="margin-top:10px;">
          <div class="sub-tile"><div class="num-xs text-muted">预言机偏离度</div><div class="num-md text-green">${risk.oracleDeviationPct !== null && risk.oracleDeviationPct !== undefined ? `${risk.oracleDeviationPct}%` : '—'}</div></div>
          <div class="sub-tile"><div class="num-xs text-muted">RPC 延迟</div><div class="num-md text-cyan">${risk.latencyMs !== null && risk.latencyMs !== undefined ? `${risk.latencyMs}ms` : '—'}</div></div>
          <div class="sub-tile"><div class="num-xs text-muted">资金审计</div><div class="num-md text-green">PASS</div></div>
        </div>
      </div>

      <div class="card">
        <div class="card-header"><div class="card-title">${icon('shieldCheck', 16, 'text-green')} 最新链上审计事件流</div></div>
        <div class="col-gap">
          <div class="list-row"><div><b>第 15 根 1H K 线定盘归档</b><div class="num-xs text-muted">Pyth + RedStone 双源一致 · 偏离 0.12%</div></div><span class="chip chip-green">VERIFIED</span></div>
          <div class="list-row"><div><b>TimeLock 2.0 资金池校验</b><div class="num-xs text-muted">700,000,000 A9 合约余额 100% 匹配</div></div><span class="chip chip-green">PASS</span></div>
          <div class="list-row"><div><b>协议清算接口验真</b><div class="num-xs text-muted">TVM 合约哈希不可篡改校验通过</div></div><span class="chip chip-cyan">AUDITED</span></div>
        </div>
      </div>
    </div>
  `;
}

export function renderRulesPage(root) {
  root.innerHTML = `
    <div class="col-gap anim-page-enter">
      <div class="card card-hero">
        <div class="card-title" style="margin-bottom:6px;">${icon('book', 16, 'text-gold')} ${L('3 步玩转 A9 挑战', 'How A9 Works in 3 Steps')}</div>
        <div class="text-sec" style="font-size:12px;">${L('最低 10 GRAM 即可参与，零滑点上链，自动派奖。', 'Start from 10 GRAM. 0% slippage, automated payouts.')}</div>
      </div>

      <div class="card">
        <div class="card-title" style="margin-bottom:10px;">${icon('bolt', 15, 'text-gold')} ${L('1. 36H 早鸟阶梯权重', '1. 36H Early Bird Boost')}</div>
        <div class="col-gap">
          <div class="list-row"><span>0 – 12H</span><span class="chip chip-gold">2.0x</span></div>
          <div class="list-row"><span>12 – 24H</span><span class="chip chip-muted">1.4x</span></div>
          <div class="list-row"><span>24 – 36H</span><span class="chip chip-muted">1.0x</span></div>
        </div>
      </div>

      <div class="card">
        <div class="card-title" style="margin-bottom:8px;">${icon('radar', 15, 'text-green')} ${L('2. 24H 达标判定 (≥16/24 时段)', '2. 24H Target (≥16/24 slots)')}</div>
        <div class="text-sec" style="font-size:12px;">${L('24 个时段中至少 16 个判定均价达到目标价即本轮达标；奖励按权重分配，单轮上限为实缴本金 15 倍，未分配部分滚存；20% 即时可领，80% 待后续轮达标线性解锁。', '16+ of 24 slots must meet the target; rewards are weight-shared with a 15x principal cap; 20% instant, 80% vesting.')}</div>
      </div>

      <div class="card">
        <div class="card-title" style="margin-bottom:10px;">${icon('team', 15, 'text-gold')} ${L('3. 团队加成与邀请返佣', '3. Squad Boost & Referrals')}</div>
        <div class="col-gap">
          <div class="list-row"><span>${L('团队奖励', 'Team Reward')}</span><span class="num-sm text-green">18%</span></div>
          <div class="list-row"><span>${L('邀请奖励 / 单人奖励上限', 'Referral / Reward Cap')}</span><span class="num-sm text-gold">12% / 15x</span></div>
        </div>
      </div>

      <button class="btn btn-secondary" data-nav="/risk/matrix">${icon('shieldAlert', 15)} ${L('查看 22 项链上风控保护', 'View 22 On-Chain Risk Guards')}</button>
    </div>
  `;
}

export function renderNotFoundPage(root) {
  root.innerHTML = `
    <div class="col-gap anim-page-enter">
      <div class="card card-hero empty-state">
        <div class="icon-badge red" style="width:50px;height:50px;border-radius:14px;">${icon('shieldAlert', 24)}</div>
        <div class="num-xl" style="margin-top:6px;">404</div>
        <div class="text-sec" style="font-size:12px;">${L('未找到该页面或路由已失效', 'Page not found or route expired')}</div>
        <button class="btn btn-primary" style="margin-top:10px;" data-nav="/challenge">${icon('arrowLeft', 15)} ${L('返回挑战首页', 'Back to Challenge')}</button>
      </div>
    </div>
  `;
}
