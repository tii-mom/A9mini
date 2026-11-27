/**
 * 已退役的历史图鉴兼容组件（从 wealthverse.js 迁出存档）。
 * 历史深链 #/gallery、#/gallery/:id 与 startapp=gallery_* 现由 ROUTE_ALIASES 统一收敛至 #/profile。
 */
import { L } from '../../i18n.js';
import { icon } from '../../icons.js';
import { escapeHtml } from '../../components.js';

export function gallery(root, _navigate, param) {
  const archivedRef = param ? String(param).replace(/[^A-Za-z0-9._-]/g, '').slice(0, 32) : '';
  root.innerHTML = `<div class="col-gap anim-page-enter">
    <section class="card card-hero col-gap">
      <div class="row-between">
        <span class="chip chip-muted">${L('历史内容', 'Archived')}</span>
        ${archivedRef ? `<span class="num-xs text-muted mono">#${escapeHtml(archivedRef)}</span>` : ''}
      </div>
      <div class="row-start" style="gap:12px;">
        <span class="nt-art-badge tone-red" aria-hidden="true">${icon('book', 24)}</span>
        <div style="min-width:0;">
          <h1 style="margin:0;font-size:17px;font-weight:900;line-height:1.25;">${L('原角色图鉴功能已退役', 'Character Archive Retired')}</h1>
          <p class="num-xs text-sec" style="margin:4px 0 0;line-height:1.5;">${L('现役小程序已聚焦广场、闯关、宝箱商城与战队，不再提供角色解锁、装备或图鉴展示；历史分享链接仍可安全访问。', 'The active app now focuses on Plaza, Quest, Chest Mall, and Squad. Character unlocks, equips, and gallery views have been retired.')}</p>
        </div>
      </div>
      <div class="grid-2" style="gap:8px;">
        <a class="btn btn-primary" href="#/challenge">${icon('navCity', 16)} ${L('前往广场', 'Go to Plaza')}</a>
        <a class="btn btn-secondary" href="#/rules">${icon('book', 15)} ${L('规则与透明', 'Rules & Transparency')}</a>
      </div>
    </section>
  </div>`;
}
