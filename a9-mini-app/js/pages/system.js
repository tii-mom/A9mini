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
import { renderCurrentRoute, getTheme, toggleTheme } from '../app.js';

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
  { id: '12', code: 'ERR_0x3312_TG_AUTH_REQUIRED', cat: 'market', title: '未绑定 TG 账号阻断兑换屋兑换', desc: '独立外部钱包缺少 Telegram InitData 签名校验。', action: '绑定 Telegram 账号' },
  { id: '13', code: 'ERR_0x3313_PRESALE_SOLD_OUT', cat: 'market', title: '兑换屋当期额度已售罄 (Sold Out)', desc: '兑换屋总额度已被抢空，后发交易由系统原路免手续费退还。', action: '查询自动退款流水' },
  { id: '14', code: 'ERR_0x3314_USER_CANCELLATION', cat: 'market', title: '用户主动取消兑换屋订单', desc: '锁仓前主动撤单，扣除固定 0.05 GRAM 计算损耗费后退回余额。', action: '确认撤单规则' },
  { id: '15', code: 'ERR_0x3315_DUST_NON_REFUNDABLE', cat: 'market', title: '粉尘金额转账 (≤0.1 GRAM 拦截)', desc: '微小数额低于链上拆单成本，协议直接拦截。', action: '调整至有效档位' },
  { id: '16', code: 'ERR_0x4416_CAPTAIN_CANNOT_EXIT', cat: 'team', title: '战队队长试图退队阻断', desc: '队长绑定分润金库，需先移交队长权限方可离队。', action: '前往移交队长权限' },
  { id: '17', code: 'ERR_0x4417_TEAM_SWITCH_QUOTA', cat: 'team', title: '赛季内切换战队超过 1 次限制', desc: '每个赛季严格限制仅可迁移战队 1 次，防止套利。', action: '等待下赛季重置' },
  { id: '18', code: 'ERR_0x4418_PREHEAT_ELIGIBILITY', cat: 'team', title: '开局预热未达到 ≥1 名有效直邀门槛', desc: '需至少邀请 1 位完成入金认证的真实伙伴以激活排位资格。', action: '分享专属邀请链' },
  { id: '19', code: 'ERR_0x4419_INVITE_HARDCAP', cat: 'team', title: '邀友奖励达 320,000 A9 单轮硬顶', desc: '单地址单轮邀友奖励封顶，多余积分自动转入社区奖池。', action: '查看邀友奖励上限' },
  { id: '20', code: 'ERR_0x5520_TG_BOT_PERM_LOST', cat: 'sys', title: 'TG 群组解绑 / Bot 管理员权限丢失', desc: '关联群组撤销了 @A9Terminal_bot 管理员权限。', action: '重新授权 Bot Admin' },
  { id: '21', code: 'ERR_0x5521_RENEWAL_TIMEOUT', cat: 'sys', title: '续期策略撤销超时 (<30分钟锁定)', desc: '已进入新轮开盘前 30 分钟锁定缓冲期。', action: '等待下轮开盘后调整' },
  { id: '22', code: 'ERR_0x5522_UPGRADE_PAUSED', cat: 'sys', title: '智能合约升级维护公告态', desc: '多签理事会正在执行 TVM 无缝升级，暂停读写 15 分钟。', action: '订阅官方升级频道' }
];

export function renderSettingsPage(root) {
  const { settings, user } = store.state;
  const curLangObj = LANGUAGES.find(l => l.code === settings.language) || LANGUAGES[0];
  const isDark = getTheme() === 'dark';

  root.innerHTML = `
    <div class="col-gap anim-page-enter">
      <div class="section-kicker">${L('外观与触感', 'APPEARANCE & SOUND')}</div>
      <div class="card">
        <div class="list-row">
          <div>
            <div style="font-weight:800;">${L('石墨暗夜纸本', 'Graphite Dark Theme')}</div>
            <div class="num-xs text-muted">${isDark ? L('当前：石墨暗夜纸本', 'Current: Graphite dark paper') : L('当前：红白雪宣纸', 'Current: Crisp snow paper')}</div>
          </div>
          <div class="a9-switch ${isDark ? 'on' : ''}" id="set-theme-switch" role="switch" aria-checked="${isDark}" tabindex="0"></div>
        </div>
        <div class="list-row">
          <div>
            <div style="font-weight:800;">${L('纸艺交互音效', 'Tactile Paper Sound')}</div>
            <div class="num-xs text-muted">${L('默认静音，开启后在切页、盖章与确认时轻响', 'Muted by default; subtle chime on key actions')}</div>
          </div>
          <div class="a9-switch ${A9Audio.isEnabled() ? 'on' : ''}" id="set-sound-switch" role="switch" aria-checked="${A9Audio.isEnabled()}" tabindex="0"></div>
        </div>
      </div>

      <div class="section-kicker">${L('账户与连接', 'ACCOUNT & CONNECTIONS')}</div>
      <div class="card">
        <div class="list-row clickable" id="set-wallet-row">
          <div><div style="font-weight:700;">${L('钱包管理 (TON Connect 2.0)', 'Wallet (TON Connect 2.0)')}</div><div class="num-xs text-muted">${user.connected ? (user.shortAddress || user.address) : L('未连接', 'Disconnected')}</div></div>
          <span class="chip ${user.connected ? 'chip-green' : 'chip-gold'}">${user.connected ? L('已连接', 'Connected') : L('去连接', 'Connect')}</span>
        </div>
        <div class="list-row clickable" id="set-tg-row" style="margin-top:6px;">
          <div><div style="font-weight:700;">${L('Telegram 账号绑定', 'Telegram Binding')}</div><div class="num-xs text-muted">${user.tgBound ? user.username : L('兑换屋与战队功能需绑定', 'Required for Exchange & Squad')}</div></div>
          <span class="chip ${user.tgBound ? 'chip-green' : 'chip-gold'}">${user.tgBound ? L('已绑定', 'Bound') : L('立即绑定', 'Bind')}</span>
        </div>
        <div class="list-row clickable" id="set-lang-row" style="margin-top:6px;">
          <div><div style="font-weight:700;">${L('界面语言 (8 语种)', 'Language (8 Languages)')}</div><div class="num-xs text-muted">${curLangObj.label}</div></div>
          <span class="chip chip-muted">${curLangObj.code} ${icon('chevronDown', 11)}</span>
        </div>
      </div>

      <div class="section-kicker">${L('提醒与系统', 'NOTIFICATIONS & SYSTEM')}</div>
      <div class="card">
        <div class="list-row"><span>${L('整点 1H 时段收盘推送', 'Hourly Slot Close Push')}</span><div class="a9-switch ${settings.hourlyCandlePush ? 'on' : ''}" data-pref="hourlyCandlePush"></div></div>
        <div class="list-row"><span>${L('轮次结算与领取提醒', 'Settlement & Claim Alerts')}</span><div class="a9-switch ${settings.settlementPush ? 'on' : ''}" data-pref="settlementPush"></div></div>
      </div>

      <div class="grid-2">
        <button class="btn btn-secondary" data-nav="/rules">${icon('book', 15)} ${L('闯关指南', 'How to Play')}</button>
        <button class="btn btn-secondary" data-nav="/risk/matrix">${icon('shieldAlert', 15)} ${L('安全护盾', 'Safety Shield')}</button>
      </div>
      ${config.isDemo ? `<button class="btn btn-danger" id="btn-reset-demo">${icon('refresh', 15)} ${L('重置本地演示数据', 'Reset Demo Data')}</button>` : ''}
    </div>
  `;

  const themeSw = root.querySelector('#set-theme-switch');
  if (themeSw) {
    const doTheme = (e) => {
      const next = toggleTheme(e);
      showToast(next === 'dark' ? L('已切换石墨暗夜纸本', 'Graphite dark theme') : L('已切换红白雪宣纸', 'Crisp snow paper theme'));
    };
    themeSw.onclick = doTheme;
    themeSw.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); doTheme(e); } };
  }

  root.querySelector('#set-wallet-row').onclick = () => tonConnect.openConnectModal(renderCurrentRoute);
  root.querySelector('#set-tg-row').onclick = () => {
    if (!config.isDemo) { showToast(L('请在 Telegram 内核验身份', 'Verify identity in Telegram')); return; }
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
      showToast(on ? L('纸艺交互音效已开启', 'Tactile Sound On') : L('交互音效已静音', 'Sound Muted'));
      renderSettingsPage(root);
    };
    soundSw.onclick = toggleSound;
    soundSw.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleSound(); } };
  }
  root.querySelectorAll('[data-pref]').forEach(el => {
    el.onclick = () => { A9Haptic.tick(); const k = el.dataset.pref; store.update(s => { s.settings[k] = !s.settings[k]; }); renderSettingsPage(root); };
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
          <button class="seg-tab ${filter === 'market' ? 'active' : ''}" data-rf="market">兑换屋</button>
          <button class="seg-tab ${filter === 'team' ? 'active' : ''}" data-rf="team">战队</button>
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
  if (!config.isDemo) {
    root.innerHTML = `
      <div class="col-gap anim-page-enter">
        <section class="card empty-state">
          <div class="icon-badge sky">${icon('shieldCheck', 20)}</div>
          <div style="font-size:15px;font-weight:800;">${L('暂无链上验真记录', 'No on-chain proofs yet')}</div>
          <p class="num-xs text-sec" style="margin:0;max-width:260px;">${L('实时验真事件流将在主网合约接入后按时间展示。', 'On-chain proof logs will appear chronologically after mainnet launch.')}</p>
          <a class="btn btn-secondary btn-sm" style="margin-top:8px;" href="#/round">${L('返回轮次闯关', 'Back to Quest')}</a>
        </section>
      </div>`;
    return;
  }
  const { risk } = store.state;
  const events = [
    { time: '12:00 UTC', target: L('第 12 时段收盘定盘', 'Slot #12 hourly seal'), detail: 'Pyth + RedStone · 0.12%', result: 'VERIFIED', cls: 'chip-green' },
    { time: '08:00 UTC', target: L('奖池合约余额校验', 'Reward pool balance check'), detail: '700,000,000 A9 · 100%', result: 'PASS', cls: 'chip-green' },
    { time: '00:00 UTC', target: L('v15 结算逻辑验真', 'v15 settlement verification'), detail: 'RoundController · TVM', result: 'AUDITED', cls: 'chip-blue' },
  ];
  root.innerHTML = `
    <div class="col-gap anim-page-enter">
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
}

export function renderRulesPage(root) {
  root.innerHTML = `
    <div class="col-gap anim-page-enter">
      <div class="card card-hero">
        <div class="row-between">
          <div>
            <span class="diorama-kicker">A9 / RULEBOOK</span>
            <h2 style="margin:3px 0 4px;font-size:18px;font-weight:900;">${L('3 分钟玩懂 A9 玩法', 'Understand A9 in 3 Minutes')}</h2>
            <p class="num-xs text-sec" style="margin:0;">${L('动手点一点下方折纸图解卡，瞬间看懂早鸟权重份额与 16/24 通关线。', 'Tap & slide the origami cards below to feel early weights and the 16/24 rule.')}</p>
          </div>
          <img src="./assets/paper-craft/rules.png" alt="" style="width:48px;height:48px;filter:var(--paper-cut-shadow);flex-shrink:0;">
        </div>
      </div>

      <!-- 交互折纸卡 1：早鸟权重份额对比 -->
      <section class="card rule-sim-card" id="rule-weight-sim">
        <div class="row-between">
          <div class="card-title">${icon('bolt', 15, 'text-gold')} ${L('交互折纸 · 早鸟权重份额', 'Interactive · Early Weight')}</div>
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
            <span class="text-sec">${L('假设参与 100 GRAM 折算权重', '100 GRAM effective weight')}</span>
            <b class="mono text-gold" id="rule-weight-val">200 权重份（相对末段 2.00 倍）</b>
          </div>
          <div class="num-xs text-muted" id="rule-weight-desc">${L('仅影响达标后奖励池瓜分份额，不改变本金或 15 倍封顶上限。', 'Only affects reward pool share on passing rounds; 15× cap unchanged.')}</div>
        </div>
      </section>

      <!-- 交互折纸卡 2：24H 达标通关线推演滑杆 -->
      <section class="card rule-sim-card" id="rule-slot-sim">
        <div class="row-between">
          <div class="card-title">${icon('radar', 15, 'text-cyan')} ${L('交互折纸 · 24H 通关线推演', 'Interactive · 16/24 Threshold')}</div>
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
            ${L('全网第 1–5 胜即时解锁 20%（余下 4×20% 随后续达标轮释放）；第 6–10 胜即时解锁 40%（余下 2×30%）；第 11 胜起新奖励 100% 即时可领。失败轮销毁该轮质押本金、一半当轮奖池与未解锁份额，直到总奖池耗尽。', 'Wins 1–5 unlock 20% immediately (4×20% vested); wins 6–10 unlock 40% (2×30%); wins 11+ unlock 100% immediately. Failed rounds burn round principal and prior locked shares.')}
          </div>
        </details>

        <details class="faq-item">
          <summary><span>${L('4. 邀友奖励与战队加成如何领取？', '4. How are invite rewards claimed?')}</span><span class="faq-arrow">${icon('chevronDown', 15)}</span></summary>
          <div class="faq-body">
            ${L('后台独立核算邀友奖励（直邀 12% / 战队 18%）。领取时支付 0.06 GRAM 网络费用，由推广热钱包自动发 A9。当前真实模式处于只读验收阶段，真实领取入口暂未开放。', 'Invite rewards are tracked off-chain. Claiming pays a 0.06 GRAM network fee and the hot wallet sends A9. Live claims are currently disabled in read-only mode.')}
          </div>
        </details>
      </div>

      <button class="btn btn-secondary" data-nav="/risk/matrix">${icon('shieldAlert', 15)} ${L('查看 22 项链上风控保护', 'View 22 On-Chain Risk Guards')}</button>
    </div>
  `;

  // 绑定交互折纸卡 1：早鸟权重切换
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
        wVal.textContent = L(
          `${Math.round(100 * mult)} 权重份（相对末段 ${mult.toFixed(2)} 倍）`,
          `${Math.round(100 * mult)} shares (${mult.toFixed(2)}× vs late)`
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

  // 绑定交互折纸卡 2：24H 生死线推演滑杆
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
          : L('失败轮按 v15 规则销毁当轮质押本金、一半当轮奖池与未解锁余量，另一半滚存下轮。', 'Failed rounds burn round principal, half of the round pool, and unvested balances.');
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
