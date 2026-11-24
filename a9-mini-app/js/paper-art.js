/**
 * A9 纯正任天堂第一方几何舞台装饰与多色矢量功能图标库
 * - 纯正任天堂 Switch 级几何网格与清晰平涂矢量图标
 * - 保留原有导出签名以兼容全站引用
 */

export const DIORAMA_BACKDROP = `
<svg class="diorama-svg" viewBox="0 0 360 220" preserveAspectRatio="xMidYMid slice" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <defs>
    <pattern id="nt-stage-grid" width="24" height="24" patternUnits="userSpaceOnUse">
      <circle cx="2" cy="2" r="1.2" fill="var(--diorama-thread)"/>
    </pattern>
  </defs>
  <rect width="360" height="220" fill="url(#nt-stage-grid)"/>
  <rect x="0" y="0" width="360" height="4" fill="var(--nt-red)"/>
</svg>`;

/**
 * 任天堂主城阶段氛围底板：克制干净的顶部色带 + 极淡圆点矩阵，绝不干扰核心数字阅读
 * @param {'warmup'|'participation'|'observation'|'matchpoint'|'pass'|'burn'} mood
 */
export function renderCitySandtable(mood = 'observation') {
  const accent = mood === 'pass'
    ? 'var(--nt-green)'
    : mood === 'burn'
      ? 'var(--nt-rose)'
      : (mood === 'warmup' || mood === 'participation' || mood === 'matchpoint')
        ? 'var(--nt-gold)'
        : 'var(--nt-red)';

  return `
<svg class="diorama-svg sandtable-${mood}" viewBox="0 0 360 260" preserveAspectRatio="xMidYMin slice" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <defs>
    <pattern id="nt-hub-dots-${mood}" width="20" height="20" patternUnits="userSpaceOnUse">
      <circle cx="2" cy="2" r="1" fill="var(--diorama-thread)"/>
    </pattern>
  </defs>
  <rect width="360" height="260" fill="url(#nt-hub-dots-${mood})" opacity="0.65"/>
  <rect x="0" y="0" width="360" height="4" fill="${accent}"/>
</svg>`;
}

export const CITY_SANDTABLE_BACKDROP = renderCitySandtable('observation');

/**
 * 领奖页中央任天堂实体玩具宝箱 SVG（纯平几何倒角 + 亮面高光，支持 --chest-open 实时掀盖）
 */
export function renderVaultChestSvg() {
  return `
<svg class="nt-vault-chest-svg" viewBox="0 0 220 176" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <ellipse cx="110" cy="156" rx="70" ry="10" fill="rgba(23, 25, 32, 0.14)" class="chest-ground-shadow"/>

  <!-- 箱内溢出暖金光束 -->
  <g class="chest-glow">
    <path d="M52 84L28 18H192L168 84H52Z" fill="url(#a9-chest-beam)"/>
    <circle cx="110" cy="76" r="34" fill="#FFE082" opacity="0.72"/>
  </g>

  <!-- 宝箱后壁暗腔 -->
  <rect x="44" y="74" width="132" height="22" rx="6" fill="#8C5900"/>
  <g class="chest-coins-peek">
    <circle cx="82" cy="83" r="11" fill="#F7BE2C" stroke="#FFF4C2" stroke-width="2.2"/>
    <circle cx="104" cy="79" r="13" fill="#FFD152" stroke="#FFF9E0" stroke-width="2.2"/>
    <circle cx="128" cy="82" r="12" fill="#F0AE14" stroke="#FFF4C2" stroke-width="2.2"/>
    <circle cx="144" cy="86" r="9.5" fill="#D9960B" stroke="#FFE599" stroke-width="2"/>
  </g>

  <!-- 实体下箱体（无虚线缝线，精工圆润塑料高光） -->
  <g class="chest-body">
    <rect x="38" y="84" width="144" height="68" rx="16" fill="#BA8006"/>
    <rect x="38" y="82" width="144" height="64" rx="15" fill="#F0AE14" stroke="var(--nt-svg-stroke, #171920)" stroke-opacity="0.14" stroke-width="2"/>
    <rect x="46" y="88" width="128" height="10" rx="5" fill="#FFD768" opacity="0.55"/>
    <!-- 任天堂正红双扣带 -->
    <rect x="64" y="82" width="18" height="64" fill="#E60012"/>
    <rect x="138" y="82" width="18" height="64" fill="#E60012"/>
    <!-- 中央星徽卡扣 -->
    <rect x="92" y="92" width="36" height="32" rx="11" fill="#A3000D" transform="translate(0 3)"/>
    <rect x="92" y="90" width="36" height="32" rx="11" fill="#FFFFFF" stroke="#E0E3EC" stroke-width="2"/>
    <path d="M110 97L112.9 103L119.5 103.9L114.7 108.4L115.9 115L110 111.8L104.1 115L105.3 108.4L100.5 103.9L107.1 103L110 97Z" fill="#F0AE14"/>
  </g>

  <!-- 独立铰链箱盖 -->
  <g class="chest-lid">
    <path d="M36 66C36 52 47 42 62 42H158C173 42 184 52 184 66V84H36V66Z" fill="#F7BE2C" stroke="var(--nt-svg-stroke, #171920)" stroke-opacity="0.14" stroke-width="2"/>
    <path d="M52 50H168" stroke="#FFF9DF" stroke-opacity="0.85" stroke-width="3.5" stroke-linecap="round"/>
    <rect x="64" y="42" width="18" height="42" fill="#E60012"/>
    <rect x="138" y="42" width="18" height="42" fill="#E60012"/>
    <rect x="64" y="42" width="18" height="6" fill="#FF4757" opacity="0.55"/>
    <rect x="138" y="42" width="18" height="6" fill="#FF4757" opacity="0.55"/>
  </g>

  <defs>
    <linearGradient id="a9-chest-beam" x1="110" y1="18" x2="110" y2="86" gradientUnits="userSpaceOnUse">
      <stop offset="0%" stop-color="#FFE699" stop-opacity="0"/>
      <stop offset="55%" stop-color="#FFD24C" stop-opacity="0.48"/>
      <stop offset="100%" stop-color="#FFF5CC" stop-opacity="0.95"/>
    </linearGradient>
  </defs>
</svg>`;
}

/**
 * 任天堂 eShop 商店顶带
 */
export const SHOP_SCALLOP_AWNING = `
<svg class="awning-scallop-svg" viewBox="0 0 360 14" preserveAspectRatio="none" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <rect width="360" height="10" fill="#E60012"/>
  <rect y="10" width="360" height="4" fill="#A3000D"/>
  <rect x="16" y="3" width="28" height="4" rx="2" fill="#FFFFFF" opacity="0.92"/>
  <rect x="52" y="3" width="10" height="4" rx="2" fill="#FFFFFF" opacity="0.55"/>
  <rect x="316" y="3" width="28" height="4" rx="2" fill="#FFCB45"/>
</svg>`;

/**
 * 方案 A：定制任天堂第一方多色粗描边矢量功能图标（2.5px 描边 + 纯色平涂，零锯齿、自适应亮暗主题）
 * @param {'market'|'trophy'|'vault'|'rules'|'tower'|'guild'|'ticket'} name
 * @param {number} size
 */
export function renderNintendoGateIcon(name, size = 34) {
  const icons = {
    market: `
      <rect x="6" y="13" width="28" height="20" rx="5" fill="#F0AE14" stroke="var(--nt-svg-stroke, #171920)" stroke-width="2.4"/>
      <path d="M5 13C5 9.5 7.5 7 11 7H29C32.5 7 35 9.5 35 13V16H5V13Z" fill="#E60012" stroke="var(--nt-svg-stroke, #171920)" stroke-width="2.4"/>
      <rect x="17" y="7" width="6" height="26" fill="#FFFFFF" stroke="var(--nt-svg-stroke, #171920)" stroke-width="2.2"/>
      <circle cx="20" cy="19" r="3.5" fill="#E60012" stroke="var(--nt-svg-stroke, #171920)" stroke-width="2"/>`,
    trophy: `
      <path d="M11 8H29V16C29 21 25 24.5 20 24.5C15 24.5 11 21 11 16V8Z" fill="#F0AE14" stroke="var(--nt-svg-stroke, #171920)" stroke-width="2.4" stroke-linejoin="round"/>
      <path d="M11 11H7C6.5 15.5 8.5 18 11.5 18.5" stroke="var(--nt-svg-stroke, #171920)" stroke-width="2.4" stroke-linecap="round"/>
      <path d="M29 11H33C33.5 15.5 31.5 18 28.5 18.5" stroke="var(--nt-svg-stroke, #171920)" stroke-width="2.4" stroke-linecap="round"/>
      <path d="M17 24.5H23V29H17V24.5Z" fill="#E60012" stroke="var(--nt-svg-stroke, #171920)" stroke-width="2.2"/>
      <rect x="12" y="29" width="16" height="4.5" rx="2" fill="#FFFFFF" stroke="var(--nt-svg-stroke, #171920)" stroke-width="2.4"/>
      <path d="M20 11.5L21.3 14.3L24.3 14.7L22.1 16.8L22.7 19.7L20 18.3L17.3 19.7L17.9 16.8L15.7 14.7L18.7 14.3L20 11.5Z" fill="#FFFFFF"/>`,
    vault: `
      <rect x="6" y="8" width="28" height="25" rx="6" fill="#2574E8" stroke="var(--nt-svg-stroke, #171920)" stroke-width="2.4"/>
      <rect x="10" y="12" width="20" height="17" rx="3.5" fill="#FFFFFF" stroke="var(--nt-svg-stroke, #171920)" stroke-width="2"/>
      <circle cx="20" cy="20.5" r="5" fill="#F0AE14" stroke="var(--nt-svg-stroke, #171920)" stroke-width="2.2"/>
      <circle cx="20" cy="20.5" r="1.8" fill="#171920"/>
      <path d="M20 15.5V17M20 24V25.5M15 20.5H16.5M23.5 20.5H25" stroke="var(--nt-svg-stroke, #171920)" stroke-width="1.8" stroke-linecap="round"/>`,
    rules: `
      <rect x="8" y="6" width="24" height="28" rx="5" fill="#12A85D" stroke="var(--nt-svg-stroke, #171920)" stroke-width="2.4"/>
      <rect x="12" y="10" width="16" height="10" rx="2.5" fill="#FFFFFF" stroke="var(--nt-svg-stroke, #171920)" stroke-width="2"/>
      <path d="M15.5 15L18.5 17.5L24.5 12.5" stroke="#12A85D" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>
      <path d="M13 24.5H27M13 28.5H22" stroke="#FFFFFF" stroke-width="2.4" stroke-linecap="round"/>`,
    tower: `
      <path d="M11 16L20 6L29 16H11Z" fill="#E60012" stroke="var(--nt-svg-stroke, #171920)" stroke-width="2.4" stroke-linejoin="round"/>
      <rect x="12" y="16" width="16" height="17" rx="3" fill="#FFFFFF" stroke="var(--nt-svg-stroke, #171920)" stroke-width="2.4"/>
      <circle cx="20" cy="23.5" r="4.8" fill="#F0AE14" stroke="var(--nt-svg-stroke, #171920)" stroke-width="2.2"/>
      <path d="M20 21V23.8L22 25" stroke="var(--nt-svg-stroke, #171920)" stroke-width="2" stroke-linecap="round"/>`,
    guild: `
      <path d="M20 6L32 10.5V20.5C32 27.5 26.8 32 20 34.5C13.2 32 8 27.5 8 20.5V10.5L20 6Z" fill="#2574E8" stroke="var(--nt-svg-stroke, #171920)" stroke-width="2.4" stroke-linejoin="round"/>
      <path d="M20 12L22.2 16.8L27.5 17.4L23.5 20.9L24.6 26L20 23.4L15.4 26L16.5 20.9L12.5 17.4L17.8 16.8L20 12Z" fill="#F0AE14" stroke="var(--nt-svg-stroke, #171920)" stroke-width="2" stroke-linejoin="round"/>`,
    ticket: `
      <rect x="6" y="10" width="28" height="20" rx="5" fill="#E60012" stroke="var(--nt-svg-stroke, #171920)" stroke-width="2.4"/>
      <circle cx="6" cy="20" r="3" fill="#F4F5F8" stroke="var(--nt-svg-stroke, #171920)" stroke-width="2"/>
      <circle cx="34" cy="20" r="3" fill="#F4F5F8" stroke="var(--nt-svg-stroke, #171920)" stroke-width="2"/>
      <path d="M20 14.5L21.5 17.8L25 18.2L22.3 20.6L23 24L20 22.2L17 24L17.7 20.6L15 18.2L18.5 17.8L20 14.5Z" fill="#F0AE14" stroke="var(--nt-svg-stroke, #171920)" stroke-width="1.6" stroke-linejoin="round"/>`,
  };
  const body = icons[name] || icons.tower;
  return `<svg class="nt-gate-svg" width="${size}" height="${size}" viewBox="0 0 40 40" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">${body}</svg>`;
}
