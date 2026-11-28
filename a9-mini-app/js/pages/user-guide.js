/**
 * 规则与透明（#/rules）：统一承接玩法说明、费用明细、链上验真（#audit）与风控矩阵（#matrix）。
 * 严格复用 system.js 导出的 renderRiskAudit 与 renderRiskMatrix，保持既有测试契约 100% 兼容。
 */
import { L } from '../i18n.js';
import { icon } from '../icons.js';
import { config } from '../config.js';
import { PROTOCOL_SPECS } from '../data.js';
import { store } from '../store.js';
import { renderRiskAudit, renderRiskMatrix } from './system.js';

export function renderUserGuide(root, _navigate, _param = null, query = {}, anchor = '') {
  const hashAnchor = typeof window !== 'undefined' ? (String(window.location?.hash || '').split('#')[2] || '') : '';
  const activeAnchor = String(anchor || query?._anchor || query?.section || hashAnchor || '').toLowerCase();
  const destinations = [
    ['/round', 'navRound', 'is-blue', L('冲关', 'Quest'), L('看进度和仓位', 'See slots and positions')],
    ['/rewards', 'trophy', 'is-green', L('金库', 'Vault'), L('查看可领与解锁', 'Check claimable & unlocking')],
    ['/market', 'chest', 'is-red', L('宝箱', 'Chest'), L('6 档 · 直发钱包', '6 tiers · wallet delivery')],
    ['/team', 'team', 'is-amber', L('战队', 'Squad'), L('邀请返佣与任务箱', 'Referrals & task chests')],
  ];
  const outcomes = [
    ['pass', L('通关', 'Passed'), L('退 100% 本金', '100% principal back'), L('20% 奖金秒提，80% 在 14 天内逐秒解锁。', '20% of rewards available now. The other 80% unlocks over 14 days.')],
    ['miss', L('未通关', 'Missed'), L('退 95% 或 90% 本金', '95% or 90% principal back'), L('头矿 6H 锁仓退 95%，普通时段退 90%。', '95% for the first 6 hours, 90% for later locks.')],
    ['halt', L('异常中止', 'Aborted'), L('可领回 100% 本金', '100% principal refundable'), L('轮次异常 7 天后可无损取回本金。', 'Recover 100% principal if a round aborts for 7 days.')],
  ];
  const attachedFees = [
    [L('锁仓', 'Lock A9'), PROTOCOL_SPECS.stakeGasGram],
    [L('轮次领奖或退本', 'Round claim or refund'), PROTOCOL_SPECS.claimGasGram],
    [L('提前解押或 3 折急提', 'Early exit or instant cashout'), PROTOCOL_SPECS.dualClaimGasGram],
  ];
  const fixedFees = [
    [L('商城配送', 'Chest delivery'), PROTOCOL_SPECS.deliveryFeeGram, '+'],
    [L('推广领币', 'Referral claim'), PROTOCOL_SPECS.deliveryFeeGram],
  ];
  const feeRows = rows => rows.map(([label, amount, prefix = '']) =>
    `<div class="guide-fee-row"><dt>${label}</dt><dd>${prefix}${amount.toFixed(2)} GRAM</dd></div>`
  ).join('');

  root.innerHTML = `<article class="user-guide anim-page-enter">
    <header class="guide-hero">
      <h1>${L('规则与透明', 'Rules & Transparency')}</h1>
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
      <h2>${L('通关条件', 'How to Pass')}</h2>
      <ol class="guide-track">
        <li><strong>24H</strong><span>${L('锁仓', 'Lock')}</span><small>${L('最低 100 A9', 'From 100 A9')}</small></li>
        <li><strong>12H</strong><span>${L('冲价', 'Price push')}</span><small>${L('封盘禁进禁出', 'Positions locked')}</small></li>
        <li><strong>${L('结算', 'Settle')}</strong><span>${L('金库查结果', 'Results in Vault')}</span></li>
      </ol>
      <div class="guide-stamp-board">
        <strong>${L('12 个时段，至少 8 个达标', 'At least 8 of 12 slots must qualify')}</strong>
        <small>${L('每段按 1 小时均价判定。', 'Each slot uses its hourly average.')}</small>
      </div>
      <p>${L('每 1 A9 算 1 份，单轮奖金封顶 5×。锁仓期提前解押退 85% 本金，销毁 15%。', 'Each A9 counts equally. Rewards cap at 5× principal. Early exit returns 85% of principal and burns 15%.')}</p>
    </section>

    <section class="card guide-panel">
      <h2>${L('结算结果', 'Settlement Outcomes')}</h2>
      <div class="guide-outcomes">
        ${outcomes.map(([tone, status, amount, caption]) => `
          <div class="guide-result ${tone}"><span>${status}</span><div><strong>${amount}</strong><small>${caption}</small></div></div>
        `).join('')}
      </div>
      <p>${L('3 折急提只处理尚未解锁的奖金，这部分领 30%，销毁 70%。', 'Instant cashout applies to still-locked rewards. Receive 30% of that portion and burn 70%.')}</p>
      <a class="btn btn-secondary btn-sm" href="#/rewards">${L('前往金库', 'Open Vault')} ›</a>
    </section>

    <section class="card guide-panel">
      <h2>${L('签名前看费用', 'Fees before you sign')}</h2>
      <h3>${L('链上操作 · 网络手续费（多退）', 'On-chain actions · network fee (refundable excess)')}</h3>
      <dl class="guide-fees">${feeRows(attachedFees)}</dl>
      <p>${L('扣除链上费用和必要留存后，可退余量原路返回。', 'Refundable excess returns after network fees and required reserves.')}</p>
      <h3>${L('热钱包服务 · 固定收费', 'Hot wallet services · fixed fees')}</h3>
      <dl class="guide-fees">${feeRows(fixedFees)}</dl>
      <p>${L('配送费加在箱价上。固定费发放成功后不按实际成本退差。钱包发起费另计。', 'Delivery is added to the box price. Fixed fees are not reconciled after payout. Wallet sending fees apply separately.')}</p>
    </section>

    <section class="card guide-panel">
      <h2>${L('战队与推广奖励', 'Squad & referral rewards')}</h2>
      <ul class="guide-list">
        <li>${L('商城直推 6%，好友通关奖金返佣 8%。已入推广余额的奖励在「金库」合并领取。', 'Earn 6% from direct mall referrals and 8% of friends’ passing rewards. Claim credited rewards together in Vault.')}</li>
      </ul>
      <a class="btn btn-secondary btn-sm" href="#/team/invite">${L('查看邀请明细', 'View invite details')} ›</a>
    </section>

    <details class="card guide-panel" id="rules-section-audit" style="scroll-margin-top:72px;" ${activeAnchor === 'audit' ? 'open' : ''}>
      <summary>
        <span>${L('合约地址与链上参数', 'Contracts & On-Chain Parameters')}</span>
        ${icon('chevronDown', 16)}
      </summary>
      <div id="rules-audit-mount" style="margin-top:12px;"></div>
    </details>

    <details class="card guide-panel" id="rules-section-matrix" style="scroll-margin-top:72px;" ${activeAnchor === 'matrix' ? 'open' : ''}>
      <summary>
        <span>${L('22 条保护与异常说明', '22 Safeguards and Errors')}</span>
        ${icon('chevronDown', 16)}
      </summary>
      <div id="rules-matrix-mount" style="margin-top:12px;"></div>
    </details>
  </article>`;

  const auditHost = root.querySelector('#rules-audit-mount');
  const auditDetails = root.querySelector('#rules-section-audit');
  let auditMounted = false;
  const ensureAudit = () => {
    if (auditMounted || !auditHost) return;
    auditMounted = true;
    renderRiskAudit(auditHost);
  };

  const matrixHost = root.querySelector('#rules-matrix-mount');
  const matrixDetails = root.querySelector('#rules-section-matrix');
  let matrixMounted = false;
  const ensureMatrix = () => {
    if (matrixMounted || !matrixHost) return;
    matrixMounted = true;
    renderRiskMatrix(matrixHost);
  };

  if (auditDetails) {
    auditDetails.addEventListener('toggle', () => {
      if (auditDetails.open) ensureAudit();
    });
    if (auditDetails.open) {
      ensureAudit();
      auditDetails.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
    }
  }
  if (matrixDetails) {
    matrixDetails.addEventListener('toggle', () => {
      if (matrixDetails.open) ensureMatrix();
    });
    if (matrixDetails.open) {
      ensureMatrix();
      matrixDetails.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
    }
  }
}
