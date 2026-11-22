import { L } from './i18n.js';

const scenes = {
  '/internal/records': ['archive','商行订单','Exchange orders'],
  '/team/profile': ['guild','商会档案','Guild register'],
  '/team/bind-tg': ['guild','商会联络处','Guild liaison'],
  '/ledger': ['archive','奖励账簿','Reward ledger'],
  '/records': ['archive','参与记录','Participation log'],
  '/settings': ['archive','主城设置','City settings'],
  '/risk/matrix': ['observatory','风控自检','Risk checks'],
  '/risk/audit': ['archive','审计记录','Audit records'],
  '/rules': ['archive','规则藏书馆','Rule library'],
  '/challenge/confirm': ['tower','参与确认','Confirm entry'],
  '/renew': ['archive','续期设置','Renewal settings'],
  '/claim': ['vault','奖励领取','Claim rewards'],
  '/proof': ['archive','质押凭证','Stake ticket'],
  '/round': ['tower','轮次挑战','Round challenge'],
  '/challenge/success': ['archive','质押凭证','Stake ticket'],
  '/warmup': ['city','预热广场','Warm-up plaza'],
  '/warmup/rank': ['podium','预热邀请榜','Warm-up rankings'],
  '/internal/market': ['bazaar','主城商行','City exchange'],
  '/team': ['guild','商会大厅','Guild hall'],
  '/team/invite': ['guild','邀请工坊','Invitation studio'],
  '/leaderboard': ['podium','荣誉殿堂','Hall of fame'],
  '/profile': ['treasury','我的资产库','Personal vault'],
};

export function paintScene(root, path) {
  const scene = scenes[path];
  root.hidden = !scene;
  if (!scene) return;
  const [art, zh, en] = scene;
  const image = new URL(`../assets/wealthverse/game/${art}.webp`, import.meta.url);
  root.style.setProperty('--scene-art', `url("${image.href}")`);
  root.innerHTML = `<h1>${L(zh,en)}</h1>`;
}
