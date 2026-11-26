import { renderNintendoGateIcon } from '../paper-art.js';
/**
 * 排行榜 (/leaderboard) — 任天堂 Switch 风格：轮次摘要 + 分组排行列表（零假头像）
 */

import { A9Haptic } from '../tma.js';
import { A9Audio } from '../audio.js';
import { icon } from '../icons.js';
import { L } from '../i18n.js';
import { openChoiceSheet, escapeHtml } from '../components.js';
import { uiMemory } from '../app.js';
import { config } from '../config.js';
import { ROUND_META, DEMO_RANKS as DATA } from '../demo-data.js';

export function renderLeaderboard(root) {
  if (!config.isDemo) {
    root.innerHTML = `
      <div class="col-gap anim-page-enter">
        <section class="card card-hero empty-state">
          <span class="nt-art-badge tone-gold" aria-hidden="true">${renderNintendoGateIcon('trophy', 34)}</span>
          <div style="font-size:16px;font-weight:900;margin-top:4px;">${L('真实排行榜待服务端同步', 'Live Rankings Awaiting Sync')}</div>
          <div class="num-xs text-sec" style="max-width:260px;line-height:1.5;">${L('真实模式下不混用演示数据；个人榜、战队榜与邀请榜将在服务端链上结算汇总后展示。', 'Live mode never mixes demo data. Personal, squad, and invite rankings appear once synced from on-chain settlements.')}</div>
        </section>
        <div class="sw-menu-group">
          <a class="sw-menu-row" href="#/team">
            <div class="sw-menu-left"><span class="sw-menu-title">${L('返回战队', 'Back to Squad')}</span></div>
            <div class="sw-menu-right"><span class="sw-menu-arrow" aria-hidden="true">›</span></div>
          </a>
        </div>
      </div>`;
    return;
  }

  let activeTab = uiMemory.leaderboardTab || 'personal';
  let activeRound = uiMemory.leaderboardRound || 'R3';

  const render = () => {
    uiMemory.leaderboardTab = activeTab;
    uiMemory.leaderboardRound = activeRound;
    const rows = DATA[activeTab] || [];
    const meta = ROUND_META[activeRound] || ROUND_META.R3;
    root.innerHTML = `
      <div class="col-gap anim-page-enter">
        <section class="card card-hero">
          <div class="row-between" style="margin-bottom:6px;">
            <span class="card-title">${icon('trophy', 15, 'text-gold')} ${L('轮次战报摘要', 'Round Summary')}</span>
            <button class="pill-trigger neutral" id="btn-lb-round" type="button">${L(meta.zh, meta.en)} ${icon('chevronDown', 12)}</button>
          </div>
          <div class="metric-strip cols-3" style="margin:6px 0 8px;padding:8px 0;">
            <div class="metric-cell"><span class="num-xs text-muted">${L('目标底价', 'Target')}</span><span class="num-sm mono">${meta.target}</span></div>
            <div class="metric-cell"><span class="num-xs text-muted">${L('判定均价', 'TWAP')}</span><span class="num-sm text-green mono">${meta.est}</span></div>
            <div class="metric-cell"><span class="num-xs text-muted">${L('已达标 / 通关所需', 'Qualified / Required')}</span><span class="num-sm text-gold mono">${meta.bars}</span></div>
          </div>
          <div class="progress-track"><div class="progress-fill" style="width:${meta.pct}%"></div></div>
        </section>

        <div class="seg-tabs">
          <button class="seg-tab ${activeTab === 'personal' ? 'active' : ''}" data-ltab="personal" type="button">${L('个人榜', 'Traders')}</button>
          <button class="seg-tab ${activeTab === 'team' ? 'active' : ''}" data-ltab="team" type="button">${L('战队榜', 'Squads')}</button>
          <button class="seg-tab ${activeTab === 'invite' ? 'active' : ''}" data-ltab="invite" type="button">${L('邀请榜', 'Invites')}</button>
        </div>

        <div>
          <div class="sw-section-label">${L('完整排名', 'Full Rankings')}</div>
          <div class="sw-menu-group">
            ${rows.map((r) => `
              <div class="sw-rank-row" ${r.me ? 'style="background:var(--nt-gold-soft);"' : ''}>
                <span class="sw-rank-pos ${r.rank === '01' ? 'text-gold' : r.me ? 'text-green' : ''}">#${escapeHtml(r.rank)}</span>
                <div class="sw-rank-id">
                  <div style="font-weight:${r.me ? '900' : '700'};color:var(--ink);">${escapeHtml(r.name)}</div>
                  <div class="num-xs text-muted">${escapeHtml(r.ton)}</div>
                </div>
                <span class="sw-rank-val text-green">${escapeHtml(r.a9)}</span>
              </div>
            `).join('')}
          </div>
        </div>

        <div class="sw-menu-group">
          <a class="sw-menu-row" href="#/team">
            <div class="sw-menu-left"><span class="sw-menu-title">${L('返回战队', 'Back to Squad')}</span></div>
            <div class="sw-menu-right"><span class="sw-menu-arrow" aria-hidden="true">›</span></div>
          </a>
        </div>
      </div>
    `;

    root.querySelector('#btn-lb-round').onclick = () => openChoiceSheet({
      title: L('选择历史轮次战报', 'Select Round Report'),
      selected: activeRound,
      options: [
        { value: 'R3', label: L(ROUND_META.R3.zh, ROUND_META.R3.en), sub: '700,000,000 A9 · 8/12' },
        { value: 'R2', label: L(ROUND_META.R2.zh, ROUND_META.R2.en), sub: '600,000,000 A9 · +412%' },
        { value: 'R1', label: L(ROUND_META.R1.zh, ROUND_META.R1.en), sub: '500,000,000 A9 · Genesis' }
      ],
      onSelect: (val) => { activeRound = val; render(); }
    });

    root.querySelectorAll('[data-ltab]').forEach(b => {
      b.onclick = () => { A9Haptic.light(); A9Audio.tick(); activeTab = b.dataset.ltab; render(); };
    });
  };

  render();
}
