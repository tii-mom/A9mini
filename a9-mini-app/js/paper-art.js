/**
 * A9 任天堂暖棉纸立体书内联矢量布景与互动道具库
 * - DIORAMA_BACKDROP：角色立体展示舞台布景（身份图鉴），顶边挂旗已严格避让文字安全区
 * - renderCitySandtable(mood) & CITY_SANDTABLE_BACKDROP：主城动态态势沙盘，随阶段与赛点变换天色与小道具
 * - SHOP_SCALLOP_AWNING：主城商行立体扇贝红白波浪纸檐
 * - renderOrigamiChestSvg()：领奖页中央分层立体折纸宝箱（支持随滑块实时掀盖与金光溢出）
 */

export const DIORAMA_BACKDROP = `
<svg class="diorama-svg" viewBox="0 0 360 230" preserveAspectRatio="xMidYMid slice" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <!-- 极高顶弧手工小挂旗（位于顶边 2~18px 安全带，避让所有文字） -->
  <path d="M110 -2Q180 18 250 -2" stroke="var(--diorama-thread)" stroke-width="1.15" stroke-dasharray="3 3" fill="none"/>
  <polygon points="134,5 145,7 139,17" fill="var(--diorama-bunting-1)" stroke="var(--diorama-rim)" stroke-width="1.3" stroke-linejoin="round"/>
  <polygon points="174,9 186,9 180,20" fill="var(--diorama-bunting-2)" stroke="var(--diorama-rim)" stroke-width="1.3" stroke-linejoin="round"/>
  <polygon points="215,7 226,5 221,17" fill="var(--diorama-bunting-3)" stroke="var(--diorama-rim)" stroke-width="1.3" stroke-linejoin="round"/>

  <!-- 两侧细虚线悬垂剪纸星星 -->
  <line x1="42" y1="42" x2="42" y2="74" stroke="var(--diorama-thread)" stroke-width="1.15" stroke-dasharray="2.5 2.5"/>
  <g class="hanging-star s-left">
    <path d="M42 67L44.6 72.8L51 73.5L46.1 77.8L47.4 84L42 80.8L36.6 84L37.9 77.8L33 73.5L39.4 72.8L42 67Z" fill="#FFFFFF" stroke="#FFFFFF" stroke-width="4.2" stroke-linejoin="round"/>
    <path d="M42 67L44.6 72.8L51 73.5L46.1 77.8L47.4 84L42 80.8L36.6 84L37.9 77.8L33 73.5L39.4 72.8L42 67Z" fill="var(--diorama-star)"/>
  </g>
  <line x1="318" y1="40" x2="318" y2="68" stroke="var(--diorama-thread)" stroke-width="1.15" stroke-dasharray="2.5 2.5"/>
  <g class="hanging-star s-right">
    <path d="M318 61L320.2 66L325.6 66.6L321.5 70.2L322.6 75.5L318 72.8L313.4 75.5L314.5 70.2L310.4 66.6L315.8 66L318 61Z" fill="#FFFFFF" stroke="#FFFFFF" stroke-width="4" stroke-linejoin="round"/>
    <path d="M318 61L320.2 66L325.6 66.6L321.5 70.2L322.6 75.5L318 72.8L313.4 75.5L314.5 70.2L310.4 66.6L315.8 66L318 61Z" fill="var(--diorama-star)"/>
  </g>

  <!-- 手工厚纸剪纸浮云 -->
  <g class="paper-cloud c-left">
    <path d="M16 126C16 120 21 115.8 27 115.8C28.6 110 34 106 40.5 106C48 106 54 111.5 55 118.8C59.2 119.6 62.5 123 62.5 127C62.5 131.5 58.8 134.8 54 134.8H24C19.5 134.8 16 131 16 126Z" fill="var(--diorama-cloud-shadow)" transform="translate(0 3)"/>
    <path d="M16 126C16 120 21 115.8 27 115.8C28.6 110 34 106 40.5 106C48 106 54 111.5 55 118.8C59.2 119.6 62.5 123 62.5 127C62.5 131.5 58.8 134.8 54 134.8H24C19.5 134.8 16 131 16 126Z" fill="var(--diorama-cloud)"/>
  </g>
  <g class="paper-cloud c-right">
    <path d="M290 118C290 113 294 109.5 299 109.5C300.5 104.8 304.8 101.5 310 101.5C316.2 101.5 321.4 106 322.2 112C325.8 112.6 328.5 115.5 328.5 119C328.5 122.8 325.2 125.5 321.2 125.5H296.8C293 125.5 290 122.3 290 118Z" fill="var(--diorama-cloud-shadow)" transform="translate(0 3)"/>
    <path d="M290 118C290 113 294 109.5 299 109.5C300.5 104.8 304.8 101.5 310 101.5C316.2 101.5 321.4 106 322.2 112C325.8 112.6 328.5 115.5 328.5 119C328.5 122.8 325.2 125.5 321.2 125.5H296.8C293 125.5 290 122.3 290 118Z" fill="var(--diorama-cloud)"/>
  </g>

  <!-- 远景淡沙纸雕微缩城堡 -->
  <g opacity="0.88">
    <path d="M96 176V138L106 122L116 138V176H96Z" fill="var(--diorama-castle)"/>
    <path d="M106 122L116 138V176H106V122Z" fill="var(--diorama-castle-shade)"/>
    <path d="M244 176V140L254 126L264 140V176H244Z" fill="var(--diorama-castle)"/>
    <path d="M254 126L264 140V176H254V126Z" fill="var(--diorama-castle-shade)"/>
    <path d="M120 176V146H134V136H148V146H212V136H226V146H240V176H120Z" fill="var(--diorama-castle)"/>
    <path d="M106 122V112L116 116L106 119.5Z" fill="var(--diorama-flag)"/>
    <path d="M254 126V117L263 120.5L254 123.8Z" fill="var(--diorama-flag)"/>
  </g>

  <!-- 手工剪纸小圆树 -->
  <g>
    <rect x="65" y="160" width="5" height="16" rx="2" fill="var(--diorama-trunk)"/>
    <circle cx="67.5" cy="151" r="12.5" fill="var(--diorama-tree)" stroke="var(--diorama-rim)" stroke-width="2.4"/>
    <rect x="292" y="163" width="5" height="15" rx="2" fill="var(--diorama-trunk)"/>
    <circle cx="294.5" cy="155" r="10.5" fill="var(--diorama-tree)" stroke="var(--diorama-rim)" stroke-width="2.4"/>
  </g>

  <!-- 后层鼠尾草淡灰绿剪纸山丘 + 前层暖米手工针脚草坡 -->
  <path d="M-20 185C46 149 126 149 198 176C268 201 322 162 380 172V240H-20V185Z" fill="var(--diorama-hill-sage)" stroke="var(--diorama-rim)" stroke-width="3"/>
  <path d="M-20 204C56 177 134 196 214 177C282 160 334 177 380 192V240H-20V204Z" fill="var(--paper-hill-2)" stroke="var(--diorama-rim)" stroke-width="3"/>
  <path d="M-10 209C60 184 136 202 214 183C280 167 332 183 374 197" stroke="var(--diorama-stitch)" stroke-width="1.2" stroke-dasharray="4 4" fill="none"/>
</svg>`;

/**
 * 动态情绪沙盘布景：随真实轮次状态切换天色、云塔氛围与小道具
 * @param {'warmup'|'participation'|'observation'|'matchpoint'|'pass'|'burn'} mood
 */
export function renderCitySandtable(mood = 'observation') {
  const skyProp = (() => {
    if (mood === 'warmup' || mood === 'participation') {
      return `
        <!-- 晨光纸艺朝阳 -->
        <g class="sandtable-sun" opacity="0.58">
          <circle cx="316" cy="58" r="22" fill="var(--nt-gold-soft)"/>
          <circle cx="316" cy="58" r="13" fill="var(--diorama-star)"/>
          <path d="M316 32V38M316 78V84M290 58H296M336 58H342M298 40L302 44M330 72L334 76M334 40L330 44M302 72L298 76" stroke="var(--diorama-star)" stroke-width="2" stroke-linecap="round"/>
        </g>`;
    }
    if (mood === 'matchpoint') {
      return `
        <!-- 赛点黄昏灯塔脉冲光晕 -->
        <g class="sandtable-beacon">
          <circle cx="32" cy="150" r="18" fill="var(--nt-gold-soft)" class="beacon-pulse"/>
          <circle cx="32" cy="150" r="7" fill="var(--nt-gold)" opacity="0.55"/>
          <circle cx="324" cy="153" r="16" fill="var(--nt-red-soft)" class="beacon-pulse"/>
          <circle cx="324" cy="153" r="6" fill="var(--nt-red)" opacity="0.48"/>
        </g>`;
    }
    if (mood === 'pass') {
      return `
        <!-- 达标庆典剪纸星芒烟花 -->
        <g class="sandtable-firework" opacity="0.72">
          <path d="M58 46L60.2 51L65.5 51.6L61.4 55.1L62.6 60.4L58 57.6L53.4 60.4L54.6 55.1L50.5 51.6L55.8 51L58 46Z" fill="var(--diorama-star)"/>
          <path d="M308 42L310 46.5L315 47L311.3 50.2L312.3 55L308 52.5L303.7 55L304.7 50.2L301 47L306 46.5L308 42Z" fill="var(--nt-green)" opacity="0.7"/>
          <circle cx="282" cy="60" r="3" fill="var(--nt-red)" opacity="0.6"/>
          <circle cx="86" cy="66" r="2.6" fill="var(--nt-blue)" opacity="0.6"/>
        </g>`;
    }
    if (mood === 'burn') {
      return `
        <!-- 未达标沉静低饱和雨云 -->
        <g opacity="0.55">
          <path d="M276 62C276 57.2 280 53.5 285 53.5C286.6 48.8 291 45.5 296.5 45.5C303 45.5 308 50.2 308.8 56.2C312.5 56.9 315.2 59.8 315.2 63.2C315.2 67 312 69.8 307.8 69.8H282.8C279 69.8 276 66.4 276 62Z" fill="var(--diorama-cloud-shadow)"/>
          <path d="M286 74L284 80M296 74L294 80M306 74L304 80" stroke="var(--diorama-thread)" stroke-width="1.6" stroke-linecap="round"/>
        </g>`;
    }
    return '';
  })();

  return `
<svg class="diorama-svg sandtable-${mood}" viewBox="0 0 360 260" preserveAspectRatio="xMidYMax slice" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  ${skyProp}
  <!-- 柔和远景浮云（极浅低对比，不抢文字焦点） -->
  <g class="paper-cloud c-left" opacity="0.72">
    <path d="M18 78C18 73 22.5 69.5 27.6 69.5C29.1 64.8 33.8 61.5 39.2 61.5C45.6 61.5 50.8 66.2 51.6 72.2C55.2 72.9 58 75.8 58 79.2C58 83 54.8 85.8 50.6 85.8H24.8C21 85.8 18 82.4 18 78Z" fill="var(--diorama-cloud)"/>
  </g>
  <g class="paper-cloud c-right" opacity="0.68">
    <path d="M292 70C292 65.8 295.6 62.6 300 62.6C301.2 58.6 305 55.8 309.6 55.8C314.8 55.8 319.2 59.8 319.8 65C322.8 65.6 325.2 68 325.2 71C325.2 74.2 322.4 76.6 318.8 76.6H297.8C294.6 76.6 292 73.8 292 70Z" fill="var(--diorama-cloud)"/>
  </g>

  <!-- 远景淡沙纸雕广场双塔剪影 -->
  <g opacity="0.62">
    <path d="M22 215V176L32 160L42 176V215H22Z" fill="var(--diorama-castle)"/>
    <path d="M32 160L42 176V215H32V160Z" fill="var(--diorama-castle-shade)"/>
    <path d="M314 215V178L324 163L334 178V215H314Z" fill="var(--diorama-castle)"/>
    <path d="M324 163L334 178V215H324V163Z" fill="var(--diorama-castle-shade)"/>
    <path d="M32 160V150L42 154L32 157.5Z" fill="var(--diorama-flag)"/>
    <path d="M324 163V153L333 157L324 160.2Z" fill="var(--diorama-flag)"/>
  </g>

  <!-- 底部三层温柔剪纸山坡与手工缝线 -->
  <path d="M-20 214C56 184 134 190 212 212C278 230 330 198 380 206V270H-20V214Z" fill="var(--diorama-hill-sage)" stroke="var(--diorama-rim)" stroke-width="2.6" opacity="0.82"/>
  <path d="M-20 232C68 208 152 226 232 210C296 198 342 210 380 222V270H-20V232Z" fill="var(--paper-hill-2)" stroke="var(--diorama-rim)" stroke-width="2.6" opacity="0.86"/>
  <path d="M-10 237C70 214 152 232 232 216C294 204 340 216 374 227" stroke="var(--diorama-stitch)" stroke-width="1.2" stroke-dasharray="4 4" fill="none"/>
</svg>`;
}

export const CITY_SANDTABLE_BACKDROP = renderCitySandtable('observation');

/**
 * 领奖页中央分层立体折纸宝箱 SVG
 * - .chest-glow：随右滑进度渐亮的箱内金光
 * - .chest-lid：独立折纸箱盖，受 CSS 变量 --chest-open (0..1) 实时驱动旋转上掀
 */
export function renderOrigamiChestSvg() {
  return `
<svg class="origami-chest-svg" viewBox="0 0 220 176" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <!-- 暖纸台面柔和接触影 -->
  <ellipse cx="110" cy="156" rx="74" ry="11" fill="rgba(43, 37, 35, 0.14)" class="chest-ground-shadow"/>

  <!-- 箱内溢出暖金光束（随 --chest-open 展开） -->
  <g class="chest-glow">
    <path d="M52 84L26 20H194L168 84H52Z" fill="url(#a9-chest-beam)"/>
    <circle cx="110" cy="76" r="34" fill="#FFE082" opacity="0.65"/>
  </g>

  <!-- 宝箱后壁暗腔 -->
  <rect x="44" y="74" width="132" height="22" rx="6" fill="#9E690C"/>
  <!-- 箱内若隐若现的 A9 纸片金币堆 -->
  <g class="chest-coins-peek">
    <circle cx="82" cy="83" r="11" fill="#F9C33F" stroke="#FFF4C2" stroke-width="2"/>
    <circle cx="104" cy="79" r="13" fill="#FFD152" stroke="#FFF9E0" stroke-width="2.2"/>
    <circle cx="128" cy="82" r="12" fill="#F3B82C" stroke="#FFF4C2" stroke-width="2"/>
    <circle cx="144" cy="86" r="9.5" fill="#E39D14" stroke="#FFE599" stroke-width="1.8"/>
  </g>

  <!-- 折纸宝箱下箱体 -->
  <g class="chest-body">
    <rect x="38" y="84" width="144" height="68" rx="14" fill="#FFFFFF" stroke="#E4E6EE" stroke-width="3"/>
    <rect x="42" y="86" width="136" height="62" rx="11" fill="#F5B82E"/>
    <path d="M110 86H167C173.1 86 178 90.9 178 97V137C178 143.1 173.1 148 167 148H110V86Z" fill="#DE9A14"/>
    <!-- 手工缝线装饰框 -->
    <rect x="49" y="94" width="122" height="46" rx="7" stroke="#FFF3C8" stroke-opacity="0.62" stroke-width="1.6" stroke-dasharray="4 3.5"/>
    <!-- 任天堂正红礼带与中折暗面 -->
    <rect x="98" y="86" width="24" height="62" fill="#E60012"/>
    <rect x="110" y="86" width="12" height="62" fill="#B8000F"/>
    <!-- 立体锁扣盾章 -->
    <rect x="95" y="96" width="30" height="26" rx="9" fill="#1B1D24" fill-opacity="0.16" transform="translate(0 2)"/>
    <rect x="95" y="95" width="30" height="26" rx="9" fill="#FFFFFF" stroke="#E4E6EE" stroke-width="1.5"/>
    <path d="M110 101L112.4 106L118 106.8L113.9 110.6L114.9 116L110 113.3L105.1 116L106.1 110.6L102 106.8L107.6 106L110 101Z" fill="#F2B21B"/>
  </g>

  <!-- 独立铰链折纸箱盖（围绕底部铰链旋转掀开） -->
  <g class="chest-lid">
    <path d="M36 66C36 53 46 44 60 44H160C174 44 184 53 184 66V86H36V66Z" fill="#FFFFFF" stroke="#E4E6EE" stroke-width="3"/>
    <path d="M40 66C40 55.5 48.5 48 59 48H161C171.5 48 180 55.5 180 66V83H40V66Z" fill="#FFCB45"/>
    <path d="M110 48H161C171.5 48 180 55.5 180 66V83H110V48Z" fill="#ECAC1F"/>
    <path d="M52 53H168" stroke="#FFF9DF" stroke-opacity="0.78" stroke-width="2" stroke-linecap="round"/>
    <!-- 盒盖正红丝带 + 立体折纸蝴蝶结 -->
    <rect x="98" y="48" width="24" height="35" fill="#E60012"/>
    <rect x="110" y="48" width="12" height="35" fill="#B8000F"/>
    <path d="M110 48C98 30 76 28 73 39C70.5 48 84 50 110 48Z" fill="#E60012"/>
    <path d="M110 48C122 30 144 28 147 39C149.5 48 136 50 110 48Z" fill="#B8000F"/>
    <circle cx="110" cy="47" r="6" fill="#F72434"/>
  </g>

  <defs>
    <linearGradient id="a9-chest-beam" x1="110" y1="20" x2="110" y2="86" gradientUnits="userSpaceOnUse">
      <stop offset="0%" stop-color="#FFE699" stop-opacity="0"/>
      <stop offset="55%" stop-color="#FFD24C" stop-opacity="0.45"/>
      <stop offset="100%" stop-color="#FFF5CC" stop-opacity="0.92"/>
    </linearGradient>
  </defs>
</svg>`;
}

export const SHOP_SCALLOP_AWNING = `
<svg class="awning-scallop-svg" viewBox="0 0 360 28" preserveAspectRatio="none" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <g transform="translate(0 3)" opacity="0.14">
    <path d="M0 0H360V12C360 19 351 23 342 23C333 23 324 19 324 12C324 19 315 23 306 23C297 23 288 19 288 12C288 19 279 23 270 23C261 23 252 19 252 12C252 19 243 23 234 23C225 23 216 19 216 12C216 19 207 23 198 23C189 23 180 19 180 12C180 19 171 23 162 23C153 23 144 19 144 12C144 19 135 23 126 23C117 23 108 19 108 12C108 19 99 23 90 23C81 23 72 19 72 12C72 19 63 23 54 23C45 23 36 19 36 12C36 19 27 23 18 23C9 23 0 19 0 12V0Z" fill="#1B1D24"/>
  </g>
  <path d="M0 0H36V12C36 19 27 23 18 23C9 23 0 19 0 12V0Z" fill="#E60012"/>
  <path d="M36 0H72V12C72 19 63 23 54 23C45 23 36 19 36 12V0Z" fill="#FFFFFF"/>
  <path d="M72 0H108V12C108 19 99 23 90 23C81 23 72 19 72 12V0Z" fill="#E60012"/>
  <path d="M108 0H144V12C144 19 135 23 126 23C117 23 108 19 108 12V0Z" fill="#FFFFFF"/>
  <path d="M144 0H180V12C180 19 171 23 162 23C153 23 144 19 144 12V0Z" fill="#E60012"/>
  <path d="M180 0H216V12C216 19 207 23 198 23C189 23 180 19 180 12V0Z" fill="#FFFFFF"/>
  <path d="M216 0H252V12C252 19 243 23 234 23C225 23 216 19 216 12V0Z" fill="#E60012"/>
  <path d="M252 0H288V12C288 19 279 23 270 23C261 23 252 19 252 12V0Z" fill="#FFFFFF"/>
  <path d="M288 0H324V12C324 19 315 23 306 23C297 23 288 19 288 12V0Z" fill="#E60012"/>
  <path d="M324 0H360V12C360 19 351 23 342 23C333 23 324 19 324 12V0Z" fill="#FFFFFF"/>
</svg>`;
