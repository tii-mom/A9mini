import { L } from '../i18n.js';
import { icon } from '../icons.js';
import { config } from '../config.js';
import { store } from '../store.js';

export function renderUserGuide(root) {
  const destinations = [
    ['/internal/market?tab=free', 'chestOpen', 'is-green', L('免费宝箱', 'Free Chests'), L('查看开启条件', 'Check eligibility')],
    ['/internal/market', 'chest', 'is-red', L('宝箱商城', 'Chest Mall'), L('6 档 · 直发钱包', '6 tiers · wallet delivery')],
    ['/round', 'navRound', 'is-blue', L('轮次闯关', 'Round Quest'), L('看进度和仓位', 'See slots and positions')],
    ['/profile', 'wallet', 'is-amber', L('我的资产', 'My Assets'), L('查凭证与奖励', 'Find tickets and rewards')],
  ];
  const outcomes = [
    ['pass', L('通关', 'Passed'), L('退 100% 本金', '100% principal back'), L('20% 奖金秒提，80% 在 14 天内逐秒解锁。', '20% of rewards available now. The other 80% unlocks over 14 days.')],
    ['miss', L('未通关', 'Missed'), L('退 95% 或 90% 本金', '95% or 90% principal back'), L('头矿 6H 锁仓退 95%，普通时段退 90%。', '95% for the first 6 hours, 90% for later locks.')],
    ['halt', L('异常中止', 'Aborted'), L('可领回 100% 本金', '100% principal refundable'), L('在对应轮次凭证查看退本。', 'Check the round ticket for your refund.')],
  ];
  const attachedFees = [
    [L('锁仓', 'Lock A9'), '0.30 GRAM'],
    [L('轮次领奖或退本', 'Round claim or refund'), '0.22 GRAM'],
    [L('提前解押或 3 折急提', 'Early exit or instant cashout'), '0.34 GRAM'],
  ];
  const fixedFees = [
    [L('商城配送', 'Chest delivery'), '+0.06 GRAM'],
    [L('推广领币', 'Referral claim'), '0.06 GRAM'],
  ];
  const feeRows = rows => rows.map(([label, amount]) =>
    `<div class="guide-fee-row"><dt>${label}</dt><dd>${amount}</dd></div>`
  ).join('');

  root.innerHTML = `<article class="user-guide anim-page-enter">
    <header class="guide-hero">
      <h1>${L('A9 用户指南', 'A9 User Guide')}</h1>
      <p>${L('开宝箱、看冲价、领 A9。', 'Open chests, follow rounds and claim A9.')}</p>
      ${config.isDemo || !store.fundsEnabled ? `<small>${config.isDemo
        ? L('演示模式 · 使用模拟数据', 'Demo mode · simulated data')
        : L('实盘只读 · 资金操作暂未开放', 'Live read-only · fund actions unavailable')}</small>` : ''}
    </header>

    <nav class="guide-destinations" aria-label="${L('常用入口', 'Quick links')}">
      ${destinations.map(([route, glyph, tone, title, caption]) => `
        <a class="guide-tile" href="#${route}">
          <span class="guide-tile-icon ${tone}" aria-hidden="true">${icon(glyph, 20)}</span>
          <strong>${title}</strong><small>${caption}</small>
          <span class="guide-tile-arrow" aria-hidden="true">›</span>
        </a>`).join('')}
    </nav>

    <section class="card guide-panel">
      <h2>${L('一轮怎么过关？', 'How do I pass a round?')}</h2>
      <ol class="guide-track">
        <li><strong>24H</strong><span>${L('锁仓', 'Lock')}</span><small>${L('最低 100 A9', 'From 100 A9')}</small></li>
        <li><strong>12H</strong><span>${L('冲价', 'Price push')}</span><small>${L('封盘禁进禁出', 'Positions locked')}</small></li>
        <li><strong>${L('结算', 'Settle')}</strong><span>${L('查看结果', 'Check results')}</span><small>${L('在我的凭证里', 'In your ticket')}</small></li>
      </ol>
      <div class="guide-stamp-board">
        <strong>${L('12 个时段，至少 8 个达标', 'At least 8 of 12 slots must qualify')}</strong>
        <div class="guide-stamps" aria-hidden="true">
          ${[true,true,false,true,true,false,true,true,true,false,true,false].map(met =>
            `<span class="${met ? 'is-met' : ''}">${met ? '✓' : '×'}</span>`).join('')}
        </div>
        <small>${L('示例 · 按每个时段的 1H 均价判定。', 'Example · Each slot uses its 1H average.')}</small>
      </div>
      <p>${L('每 1 A9 算 1 份，单轮奖金封顶 5×。锁仓期提前解押退 85% 本金，销毁 15%。', 'Each A9 counts equally. Rewards cap at 5× principal. Early exit returns 85% of principal and burns 15%.')}</p>
    </section>

    <section class="card guide-panel">
      <h2>${L('结算后能领什么？', 'What can I claim?')}</h2>
      <div class="guide-outcomes">
        ${outcomes.map(([tone, status, amount, caption]) => `
          <div class="guide-result ${tone}"><span>${status}</span><div><strong>${amount}</strong><small>${caption}</small></div></div>
        `).join('')}
      </div>
      <p>${L('3 折急提只处理尚未解锁的奖金，这部分领 30%，销毁 70%。', 'Instant cashout applies to still-locked rewards. Receive 30% of that portion and burn 70%.')}</p>
      <a class="btn btn-secondary btn-sm" href="#/claim">${L('查看轮次奖励', 'View round rewards')} ›</a>
    </section>

    <section class="card guide-panel">
      <h2>${L('签名前看费用', 'Fees before you sign')}</h2>
      <h3>${L('链上操作 · 预附 GRAM', 'On-chain actions · attached GRAM')}</h3>
      <dl class="guide-fees">${feeRows(attachedFees)}</dl>
      <p>${L('扣除链上费用和必要留存后，可退余量原路返回。', 'Refundable excess returns after network fees and required reserves.')}</p>
      <h3>${L('热钱包服务 · 固定收费', 'Hot wallet services · fixed fees')}</h3>
      <dl class="guide-fees">${feeRows(fixedFees)}</dl>
      <p>${L('配送费加在箱价上。固定费发放成功后不按实际成本退差。钱包发起费另计。', 'Delivery is added to the box price. Fixed fees are not reconciled after payout. Wallet sending fees apply separately.')}</p>
    </section>

    <section class="card guide-panel">
      <h2>${L('预言与战队奖励', 'Predictions & squad rewards')}</h2>
      <ul class="guide-list">
        <li>${L('预言 0 GRAM 参与。待激活奖励以页面条件和到期时间为准。', 'Predictions cost 0 GRAM to enter. Check activation requirements and expiry.')}</li>
        <li>${L('商城直推 6%，好友通关奖金返佣 8%。已入推广余额的奖励可合并领取。', 'Earn 6% from direct mall referrals and 8% of friends’ passing rewards. Claim credited rewards together.')}</li>
      </ul>
      <a class="btn btn-secondary btn-sm" href="#/team/invite">${L('查看推广奖励', 'View referral rewards')} ›</a>
    </section>

    <a class="sw-menu-row guide-audit" href="#/risk/audit"><strong>${L('链上验真', 'On-chain audit')}</strong><span aria-hidden="true">›</span></a>
  </article>`;
}
