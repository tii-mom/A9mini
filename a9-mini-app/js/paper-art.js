/**
 * A9 方案 A（暖棉纸立体书 × 实体厚卡纸贴纸）内联矢量布景资产库
 * - DIORAMA_BACKDROP：角色立体展示舞台布景（用于背包个人身份展示台、身份图鉴），已避开左上标题与右上角标区域，零文字穿插
 * - CITY_SANDTABLE_BACKDROP：主城核心态势沙盘布景（用于主城首屏），顶部全净空，中下层纸雕双塔与针脚草坡轻柔托底
 * - SHOP_SCALLOP_AWNING：主城商行立体扇贝红白波浪纸檐
 */

export const DIORAMA_BACKDROP = `
<svg class="diorama-svg" viewBox="0 0 360 230" preserveAspectRatio="xMidYMid slice" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <!-- 极高顶弧手工小挂旗（位于顶边 2~18px 安全带，完全避开标题文字） -->
  <path d="M110 -2Q180 18 250 -2" stroke="var(--diorama-thread)" stroke-width="1.15" stroke-dasharray="3 3" fill="none"/>
  <polygon points="134,5 145,7 139,17" fill="var(--diorama-bunting-1)" stroke="var(--diorama-rim)" stroke-width="1.3" stroke-linejoin="round"/>
  <polygon points="174,9 186,9 180,20" fill="var(--diorama-bunting-2)" stroke="var(--diorama-rim)" stroke-width="1.3" stroke-linejoin="round"/>
  <polygon points="215,7 226,5 221,17" fill="var(--diorama-bunting-3)" stroke="var(--diorama-rim)" stroke-width="1.3" stroke-linejoin="round"/>

  <!-- 两侧细虚线悬垂剪纸星星（避让顶栏与中心立牌） -->
  <line x1="42" y1="54" x2="42" y2="86" stroke="var(--diorama-thread)" stroke-width="1.15" stroke-dasharray="2.5 2.5"/>
  <g class="hanging-star s-left">
    <path d="M42 79L44.6 84.8L51 85.5L46.1 89.8L47.4 96L42 92.8L36.6 96L37.9 89.8L33 85.5L39.4 84.8L42 79Z" fill="#FFFFFF" stroke="#FFFFFF" stroke-width="4.5" stroke-linejoin="round"/>
    <path d="M42 79L44.6 84.8L51 85.5L46.1 89.8L47.4 96L42 92.8L36.6 96L37.9 89.8L33 85.5L39.4 84.8L42 79Z" fill="var(--diorama-star)"/>
  </g>
  <line x1="318" y1="52" x2="318" y2="80" stroke="var(--diorama-thread)" stroke-width="1.15" stroke-dasharray="2.5 2.5"/>
  <g class="hanging-star s-right">
    <path d="M318 73L320.2 78L325.6 78.6L321.5 82.2L322.6 87.5L318 84.8L313.4 87.5L314.5 82.2L310.4 78.6L315.8 78L318 73Z" fill="#FFFFFF" stroke="#FFFFFF" stroke-width="4.2" stroke-linejoin="round"/>
    <path d="M318 73L320.2 78L325.6 78.6L321.5 82.2L322.6 87.5L318 84.8L313.4 87.5L314.5 82.2L310.4 78.6L315.8 78L318 73Z" fill="var(--diorama-star)"/>
  </g>

  <!-- 手工厚白边剪纸浮云 -->
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

export const CITY_SANDTABLE_BACKDROP = `
<svg class="diorama-svg" viewBox="0 0 360 260" preserveAspectRatio="xMidYMax slice" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <!-- 柔和远景浮云（极浅低对比，不抢文字焦点） -->
  <g class="paper-cloud c-left" opacity="0.72">
    <path d="M18 78C18 73 22.5 69.5 27.6 69.5C29.1 64.8 33.8 61.5 39.2 61.5C45.6 61.5 50.8 66.2 51.6 72.2C55.2 72.9 58 75.8 58 79.2C58 83 54.8 85.8 50.6 85.8H24.8C21 85.8 18 82.4 18 78Z" fill="var(--diorama-cloud)"/>
  </g>
  <g class="paper-cloud c-right" opacity="0.68">
    <path d="M292 70C292 65.8 295.6 62.6 300 62.6C301.2 58.6 305 55.8 309.6 55.8C314.8 55.8 319.2 59.8 319.8 65C322.8 65.6 325.2 68 325.2 71C325.2 74.2 322.4 76.6 318.8 76.6H297.8C294.6 76.6 292 73.8 292 70Z" fill="var(--diorama-cloud)"/>
  </g>

  <!-- 远景淡沙纸雕主城剪影 -->
  <g opacity="0.58">
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

export const SHOP_SCALLOP_AWNING = `
<svg class="awning-scallop-svg" viewBox="0 0 360 28" preserveAspectRatio="none" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <g transform="translate(0 3)" opacity="0.16">
    <path d="M0 0H360V12C360 19 351 23 342 23C333 23 324 19 324 12C324 19 315 23 306 23C297 23 288 19 288 12C288 19 279 23 270 23C261 23 252 19 252 12C252 19 243 23 234 23C225 23 216 19 216 12C216 19 207 23 198 23C189 23 180 19 180 12C180 19 171 23 162 23C153 23 144 19 144 12C144 19 135 23 126 23C117 23 108 19 108 12C108 19 99 23 90 23C81 23 72 19 72 12C72 19 63 23 54 23C45 23 36 19 36 12C36 19 27 23 18 23C9 23 0 19 0 12V0Z" fill="#2B2523"/>
  </g>
  <path d="M0 0H36V12C36 19 27 23 18 23C9 23 0 19 0 12V0Z" fill="#E8453C"/>
  <path d="M36 0H72V12C72 19 63 23 54 23C45 23 36 19 36 12V0Z" fill="#FAF4E8"/>
  <path d="M72 0H108V12C108 19 99 23 90 23C81 23 72 19 72 12V0Z" fill="#E8453C"/>
  <path d="M108 0H144V12C144 19 135 23 126 23C117 23 108 19 108 12V0Z" fill="#FAF4E8"/>
  <path d="M144 0H180V12C180 19 171 23 162 23C153 23 144 19 144 12V0Z" fill="#E8453C"/>
  <path d="M180 0H216V12C216 19 207 23 198 23C189 23 180 19 180 12V0Z" fill="#FAF4E8"/>
  <path d="M216 0H252V12C252 19 243 23 234 23C225 23 216 19 216 12V0Z" fill="#E8453C"/>
  <path d="M252 0H288V12C288 19 279 23 270 23C261 23 252 19 252 12V0Z" fill="#FAF4E8"/>
  <path d="M288 0H324V12C324 19 315 23 306 23C297 23 288 19 288 12V0Z" fill="#E8453C"/>
  <path d="M324 0H360V12C360 19 351 23 342 23C333 23 324 19 324 12V0Z" fill="#FAF4E8"/>
</svg>`;
