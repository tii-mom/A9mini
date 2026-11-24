/**
 * A9 任天堂第一方 5 阶分层矢量宝箱资产库（青铜 / 白银 / 黄金 / 白金 / 钻石）
 * - 纯正 Nintendo Switch / 马力欧精密玩具触感：2.5px 粗描边 + 纯平色面 + 硬边赛璐璐高光
 * - 严格零渐变、零发光、纯平实体色块；原生适配亮色与 Switch 暗夜双主题
 * - 语义分层（shadow / base / lid / latch），支持 locked / normal / opened 状态复用
 */

export const CHEST_TIER_META = {
  bronze: {
    key: 'bronze',
    shortZh: '青铜',
    shortEn: 'Bronze',
    accent: '#C97A42',
    accentSoft: '#FBF1E8',
    accentSoftDark: 'rgba(201, 122, 66, 0.20)',
  },
  silver: {
    key: 'silver',
    shortZh: '白银',
    shortEn: 'Silver',
    accent: '#5B7699',
    accentSoft: '#EEF3F9',
    accentSoftDark: 'rgba(143, 163, 188, 0.22)',
  },
  gold: {
    key: 'gold',
    shortZh: '黄金',
    shortEn: 'Gold',
    accent: '#D98200',
    accentSoft: '#FFF7DF',
    accentSoftDark: 'rgba(247, 190, 44, 0.20)',
    hot: true,
  },
  platinum: {
    key: 'platinum',
    shortZh: '白金',
    shortEn: 'Platinum',
    accent: '#6D5DF6',
    accentSoft: '#F1EFFD',
    accentSoftDark: 'rgba(109, 93, 246, 0.22)',
  },
  diamond: {
    key: 'diamond',
    shortZh: '钻石',
    shortEn: 'Diamond',
    accent: '#0088E8',
    accentSoft: '#E8F7FF',
    accentSoftDark: 'rgba(41, 199, 255, 0.20)',
  },
};

export function resolveChestTier(input) {
  const raw = String(
    typeof input === 'string'
      ? input
      : (input?.tier || input?.skuId || input?.labelEn || input?.zh || '')
  ).toLowerCase();
  if (raw.includes('diamond') || raw.includes('钻石')) return 'diamond';
  if (raw.includes('platinum') || raw.includes('白金')) return 'platinum';
  if (raw.includes('gold') || raw.includes('黄金')) return 'gold';
  if (raw.includes('silver') || raw.includes('白银')) return 'silver';
  return 'bronze';
}

/**
 * 渲染 5 阶任天堂第一方分层矢量宝箱 SVG
 * @param {'bronze'|'silver'|'gold'|'platinum'|'diamond'} tierInput
 * @param {{ size?: number, state?: 'normal'|'locked'|'opened', className?: string }} opts
 */
export function renderChestSvg(tierInput, { size = 64, state = 'normal', className = '' } = {}) {
  const tier = resolveChestTier(tierInput);
  const stroke = 'var(--nt-svg-stroke, #171920)';
  const isOpened = state === 'opened';
  const lidTransform = isOpened ? 'transform="translate(0 -7)"' : '';

  const bodies = {
    // 1. 青铜宝箱：焦糖暖铜 + 哑光古铜角钉 + 极简圆角方扣钥匙眼（单层利落剪影）
    bronze: `
      <ellipse class="chest-shadow" cx="48" cy="82" rx="31" ry="6" fill="rgba(20, 22, 30, 0.14)"/>
      <g class="chest-base">
        <rect x="17" y="47" width="62" height="32" rx="8" fill="#8F4F24" stroke="${stroke}" stroke-width="2.5"/>
        <rect x="17" y="45" width="62" height="29" rx="7.5" fill="#C97A42" stroke="${stroke}" stroke-width="2.5"/>
        <rect x="21" y="49" width="24" height="5" rx="2.5" fill="#E69F68"/>
        <rect x="17" y="64" width="62" height="10" rx="3" fill="#8F4F24" opacity="0.28"/>
        <circle cx="24" cy="54" r="2.2" fill="#D99B52" stroke="${stroke}" stroke-width="1.6"/>
        <circle cx="72" cy="54" r="2.2" fill="#D99B52" stroke="${stroke}" stroke-width="1.6"/>
        <circle cx="24" cy="68" r="2.2" fill="#D99B52" stroke="${stroke}" stroke-width="1.6"/>
        <circle cx="72" cy="68" r="2.2" fill="#D99B52" stroke="${stroke}" stroke-width="1.6"/>
      </g>
      <g class="chest-lid" ${lidTransform}>
        <path d="M16 40C16 30 24 24 35 24H61C72 24 80 30 80 40V47H16V40Z" fill="#C97A42" stroke="${stroke}" stroke-width="2.5" stroke-linejoin="round"/>
        <path d="M23 33C25 29 30 27.5 36 27.5H54" stroke="#E69F68" stroke-width="4" stroke-linecap="round"/>
        <rect x="27" y="24" width="8" height="23" fill="#D99B52" stroke="${stroke}" stroke-width="2.2"/>
        <rect x="61" y="24" width="8" height="23" fill="#D99B52" stroke="${stroke}" stroke-width="2.2"/>
      </g>
      <g class="chest-latch">
        <rect x="41" y="41" width="14" height="16" rx="4" fill="#D99B52" stroke="${stroke}" stroke-width="2.4"/>
        <circle cx="48" cy="47.5" r="2.3" fill="${stroke}"/>
        <path d="M48 49V53" stroke="${stroke}" stroke-width="2.2" stroke-linecap="round"/>
      </g>`,

    // 2. 白银宝箱：雾白钛银 + 双冷银加固带 + 两侧圆环提手 + 冰蓝宝石盾扣
    silver: `
      <ellipse class="chest-shadow" cx="48" cy="82" rx="33" ry="6" fill="rgba(20, 22, 30, 0.14)"/>
      <g class="chest-base">
        <circle cx="14" cy="59" r="5" fill="#8FA3BC" stroke="${stroke}" stroke-width="2.4"/>
        <circle cx="82" cy="59" r="5" fill="#8FA3BC" stroke="${stroke}" stroke-width="2.4"/>
        <rect x="16" y="47" width="64" height="32" rx="8" fill="#9AA9BE" stroke="${stroke}" stroke-width="2.5"/>
        <rect x="16" y="45" width="64" height="29" rx="7.5" fill="#E4EAF2" stroke="${stroke}" stroke-width="2.5"/>
        <rect x="20" y="49" width="26" height="5" rx="2.5" fill="#FFFFFF"/>
        <rect x="26" y="45" width="9" height="29" fill="#8FA3BC" stroke="${stroke}" stroke-width="2.2"/>
        <rect x="61" y="45" width="9" height="29" fill="#8FA3BC" stroke="${stroke}" stroke-width="2.2"/>
      </g>
      <g class="chest-lid" ${lidTransform}>
        <path d="M15 39C15 28.5 23 22 34 22H62C73 22 81 28.5 81 39V47H15V39Z" fill="#E4EAF2" stroke="${stroke}" stroke-width="2.5" stroke-linejoin="round"/>
        <path d="M22 31C24.5 27.5 29.5 26 36 26H56" stroke="#FFFFFF" stroke-width="4" stroke-linecap="round"/>
        <rect x="26" y="22" width="9" height="25" fill="#8FA3BC" stroke="${stroke}" stroke-width="2.2"/>
        <rect x="61" y="22" width="9" height="25" fill="#8FA3BC" stroke="${stroke}" stroke-width="2.2"/>
      </g>
      <g class="chest-latch">
        <path d="M40 40H56V51C56 55.5 48 59 48 59C48 59 40 55.5 40 51V40Z" fill="#FFFFFF" stroke="${stroke}" stroke-width="2.4" stroke-linejoin="round"/>
        <circle cx="48" cy="48.5" r="4" fill="#2574E8" stroke="${stroke}" stroke-width="2"/>
        <circle cx="46.8" cy="47.2" r="1.2" fill="#FFFFFF"/>
      </g>`,

    // 3. 黄金宝箱：马力欧金币黄 + 任天堂正红双漆带 + 切面护角 + 凸起五角星浮雕锁扣
    gold: `
      <ellipse class="chest-shadow" cx="48" cy="83" rx="34" ry="6.2" fill="rgba(20, 22, 30, 0.16)"/>
      <g class="chest-base">
        <path d="M12 54H17V64H12C9.8 64 8.5 61.5 8.5 59C8.5 56.5 9.8 54 12 54Z" fill="#D98200" stroke="${stroke}" stroke-width="2.4"/>
        <path d="M84 54H79V64H84C86.2 64 87.5 61.5 87.5 59C87.5 56.5 86.2 54 84 54Z" fill="#D98200" stroke="${stroke}" stroke-width="2.4"/>
        <rect x="15" y="47" width="66" height="33" rx="9" fill="#C97400" stroke="${stroke}" stroke-width="2.5"/>
        <rect x="15" y="45" width="66" height="29.5" rx="8.5" fill="#F7BE2C" stroke="${stroke}" stroke-width="2.5"/>
        <rect x="19" y="49" width="28" height="5" rx="2.5" fill="#FFF08A"/>
        <rect x="26" y="45" width="10" height="29.5" fill="#E60012" stroke="${stroke}" stroke-width="2.2"/>
        <rect x="60" y="45" width="10" height="29.5" fill="#E60012" stroke="${stroke}" stroke-width="2.2"/>
        <rect x="15" y="65" width="10" height="9.5" rx="2.5" fill="#FFE05C" stroke="${stroke}" stroke-width="2"/>
        <rect x="71" y="65" width="10" height="9.5" rx="2.5" fill="#FFE05C" stroke="${stroke}" stroke-width="2"/>
      </g>
      <g class="chest-lid" ${lidTransform}>
        <path d="M14 38C14 26.5 22.5 20 34 20H62C73.5 20 82 26.5 82 38V47H14V38Z" fill="#FFC412" stroke="${stroke}" stroke-width="2.5" stroke-linejoin="round"/>
        <path d="M21 29.5C24 25.5 29 24 36 24H58" stroke="#FFF08A" stroke-width="4.2" stroke-linecap="round"/>
        <rect x="26" y="20" width="10" height="27" fill="#E60012" stroke="${stroke}" stroke-width="2.2"/>
        <rect x="60" y="20" width="10" height="27" fill="#E60012" stroke="${stroke}" stroke-width="2.2"/>
      </g>
      <g class="chest-latch">
        <rect x="38" y="38.5" width="20" height="20" rx="6" fill="#FFFFFF" stroke="${stroke}" stroke-width="2.4"/>
        <path d="M48 42L49.9 46.1L54.4 46.6L51.1 49.6L52 54L48 51.8L44 54L44.9 49.6L41.6 46.6L46.1 46.1L48 42Z" fill="#FFC412" stroke="${stroke}" stroke-width="1.8" stroke-linejoin="round"/>
      </g>`,

    // 4. 白金宝箱：珍珠瓷白泛冷紫 + 镜面铂银护角 + 靛紫珐琅带 + 双翼六边紫晶徽章
    platinum: `
      <ellipse class="chest-shadow" cx="48" cy="83" rx="35" ry="6.2" fill="rgba(20, 22, 30, 0.16)"/>
      <g class="chest-base">
        <rect x="14" y="48" width="68" height="32" rx="9" fill="#99ACE0" stroke="${stroke}" stroke-width="2.5"/>
        <rect x="14" y="45" width="68" height="30" rx="8.5" fill="#EEF3FF" stroke="${stroke}" stroke-width="2.5"/>
        <rect x="19" y="49" width="28" height="5" rx="2.5" fill="#FFFFFF"/>
        <rect x="25" y="45" width="10" height="30" fill="#6D5DF6" stroke="${stroke}" stroke-width="2.2"/>
        <rect x="61" y="45" width="10" height="30" fill="#6D5DF6" stroke="${stroke}" stroke-width="2.2"/>
        <path d="M14 64H23V75H18C15.8 75 14 73.2 14 71V64Z" fill="#B8C7E8" stroke="${stroke}" stroke-width="2"/>
        <path d="M82 64H73V75H78C80.2 75 82 73.2 82 71V64Z" fill="#B8C7E8" stroke="${stroke}" stroke-width="2"/>
      </g>
      <g class="chest-lid" ${lidTransform}>
        <path d="M13 38C13 26 22 19 34 19H62C74 19 83 26 83 38V47H13V38Z" fill="#E6EEFF" stroke="${stroke}" stroke-width="2.5" stroke-linejoin="round"/>
        <path d="M31 19L35 14H61L65 19H31Z" fill="#B8C7E8" stroke="${stroke}" stroke-width="2.3" stroke-linejoin="round"/>
        <path d="M21 29C24 25.5 29 24 36 24H58" stroke="#FFFFFF" stroke-width="4" stroke-linecap="round"/>
        <rect x="25" y="19" width="10" height="28" fill="#6D5DF6" stroke="${stroke}" stroke-width="2.2"/>
        <rect x="61" y="19" width="10" height="28" fill="#6D5DF6" stroke="${stroke}" stroke-width="2.2"/>
      </g>
      <g class="chest-latch">
        <path d="M33 44L39 41V53L33 50V44Z" fill="#B8C7E8" stroke="${stroke}" stroke-width="2" stroke-linejoin="round"/>
        <path d="M63 44L57 41V53L63 50V44Z" fill="#B8C7E8" stroke="${stroke}" stroke-width="2" stroke-linejoin="round"/>
        <polygon points="48,37 57,42.5 57,52.5 48,58 39,52.5 39,42.5" fill="#6D5DF6" stroke="${stroke}" stroke-width="2.4" stroke-linejoin="round"/>
        <polygon points="48,41 53,44.5 53,50.5 48,54 43,50.5 43,44.5" fill="#B9B0FF"/>
        <polygon points="48,41 53,44.5 48,47.5 43,44.5" fill="#FFFFFF"/>
      </g>`,

    // 5. 钻石宝箱：切面冰钻蓝 + 耀金皇冠框架 + 双层台座 + 顶盖皇冠钻饰与八角冰钻核（剪影最高）
    diamond: `
      <ellipse class="chest-shadow" cx="48" cy="85" rx="36" ry="6.2" fill="rgba(20, 22, 30, 0.18)"/>
      <g class="chest-base">
        <rect x="11" y="71" width="74" height="10" rx="5" fill="#D98200" stroke="${stroke}" stroke-width="2.4"/>
        <rect x="15" y="46" width="66" height="29" rx="8" fill="#0077CC" stroke="${stroke}" stroke-width="2.5"/>
        <rect x="15" y="44" width="66" height="27" rx="7.5" fill="#29C7FF" stroke="${stroke}" stroke-width="2.5"/>
        <polygon points="18,48 42,48 34,58 18,58" fill="#B8F3FF"/>
        <rect x="25" y="44" width="10" height="27" fill="#FFD43B" stroke="${stroke}" stroke-width="2.2"/>
        <rect x="61" y="44" width="10" height="27" fill="#FFD43B" stroke="${stroke}" stroke-width="2.2"/>
      </g>
      <g class="chest-lid" ${lidTransform}>
        <path d="M13 38C13 26.5 22 20 34 20H62C74 20 83 26.5 83 38V46H13V38Z" fill="#29C7FF" stroke="${stroke}" stroke-width="2.5" stroke-linejoin="round"/>
        <polygon points="22,25 46,25 40,34 19,34" fill="#B8F3FF"/>
        <rect x="25" y="20" width="10" height="26" fill="#FFD43B" stroke="${stroke}" stroke-width="2.2"/>
        <rect x="61" y="20" width="10" height="26" fill="#FFD43B" stroke="${stroke}" stroke-width="2.2"/>
        <!-- 顶部皇冠钻饰（唯一延伸剪影高度的终极标识） -->
        <path d="M35 20L38 10L44 15L48 7L52 15L58 10L61 20H35Z" fill="#FFD43B" stroke="${stroke}" stroke-width="2.4" stroke-linejoin="round"/>
        <circle cx="48" cy="14.5" r="2.6" fill="#E60012" stroke="${stroke}" stroke-width="1.6"/>
      </g>
      <g class="chest-latch">
        <polygon points="44,36 52,36 59,43 59,51 52,58 44,58 37,51 37,43" fill="#FFD43B" stroke="${stroke}" stroke-width="2.4" stroke-linejoin="round"/>
        <polygon points="45.5,40 50.5,40 55,44.5 55,49.5 50.5,54 45.5,54 41,49.5 41,44.5" fill="#29C7FF" stroke="${stroke}" stroke-width="2" stroke-linejoin="round"/>
        <polygon points="45.5,40 50.5,40 53,45 43,45" fill="#FFFFFF"/>
      </g>`,
  };

  const cls = ['nt-chest-svg', `tier-${tier}`, `state-${state}`, className].filter(Boolean).join(' ');
  return `<svg class="${cls}" width="${size}" height="${size}" viewBox="0 0 96 92" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">${bodies[tier] || bodies.bronze}</svg>`;
}
