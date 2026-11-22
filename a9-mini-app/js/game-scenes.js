import { L } from './i18n.js';

/**
 * 方案 A 纸艺场景轻眉标
 * 仅在需要场景指引的一级 Tab 页（闯关 / 战队）显示紧凑折纸徽标条；
 * 广场（自带立体沙盘）、我的（自带角色立体舞台）以及所有带顶栏标题的二级栈页均不重复渲染，消除多层标题冗余。
 */
const scenes = {
  '/round': ['tower', '轮次闯关', 'Round Quest', '24H 集章闯关 · 16/24 达标胜出', '24H stamp quest · 16/24 to pass'],
  '/team':  ['guild', 'A9 战队', 'A9 Squad',     '组队冲榜 · 享最高 +15% 加成', 'Squad up · up to +15% boost'],
};

export function paintScene(root, path) {
  if (!root) return;
  const scene = scenes[path];
  root.hidden = !scene;
  if (!scene) return;
  const [sticker, zh, en, subZh, subEn] = scene;
  const src = `./assets/paper-craft/${sticker}.png`;
  root.innerHTML = `
    <img class="realm-sticker" src="${src}" alt="" aria-hidden="true">
    <div class="realm-copy">
      <h1>${L(zh, en)}</h1>
      <p>${L(subZh, subEn)}</p>
    </div>
  `;
}
