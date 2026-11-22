/**
 * A9 Lightweight Real-Time Bilingual Engine (zh-CN / en-US + 8-Language Registry)
 * Strictly aligned to official A9 terminology: 广场 / 闯关 / 战队 / 我的
 */

import { store } from './store.js';

export const LANGUAGES = [
  { code: 'zh-CN', label: '简体中文', sub: 'Chinese (Simplified)' },
  { code: 'en-US', label: 'English', sub: 'English (US)' },
  { code: 'ru-RU', label: 'Русский', sub: 'Russian' },
  { code: 'es-ES', label: 'Español', sub: 'Spanish' },
  { code: 'pt-BR', label: 'Português', sub: 'Portuguese' },
  { code: 'id-ID', label: 'Bahasa Indonesia', sub: 'Indonesian' },
  { code: 'tr-TR', label: 'Türkçe', sub: 'Turkish' },
  { code: 'vi-VN', label: 'Tiếng Việt', sub: 'Vietnamese' }
];

export function getLang() {
  return store.state.settings.language === 'zh-CN' ? 'zh-CN' : 'en-US';
}

export function L(zh, en) {
  return getLang() === 'en-US' ? en : zh;
}

export function initAutoLanguage() {
  try {
    const saved = localStorage.getItem('a9_ui_prefs_v1');
    if (saved && JSON.parse(saved)?.settings?.language) return;
  } catch (_) {}
  const tgLang = window.Telegram?.WebApp?.initDataUnsafe?.user?.language_code || navigator.language || '';
  if (tgLang && !tgLang.toLowerCase().startsWith('zh')) {
    store.update(s => { s.settings.language = 'en-US'; });
  }
}

export function toggleLang() {
  const next = getLang() === 'zh-CN' ? 'en-US' : 'zh-CN';
  store.update(s => { s.settings.language = next; });
  return next;
}

const DICT = {
  'zh-CN': {
    tab_challenge: '广场',
    tab_market: '兑换屋',
    tab_round: '闯关',
    tab_backpack: '我的',
    tab_team: '战队',
    tab_leaderboard: '财富榜',
    tab_profile: '我的',
    connect_wallet: '连接钱包',
    rt_confirm: '入场确认',
    rt_success: '入场成功',
    rt_warmup: '开局预热',
    rt_warmup_rank: '早鸟先锋榜',
    rt_market: 'A9 兑换屋',
    rt_market_rec: '兑换小票',
    rt_team_profile: '战队名片',
    rt_bind_tg: '绑定 TG 群',
    rt_invite: '邀友赢奖',
    rt_claim: '金库领奖',
    rt_proof: '闯关凭证',
    rt_renew: '自动连闯',
    rt_ledger: '收益账本',
    rt_records: '闯关战绩',
    rt_settings: '偏好设置',
    rt_risk_matrix: '安全护盾',
    rt_risk_audit: '链上验真',
    rt_rules: '闯关指南'
  },
  'en-US': {
    tab_challenge: 'Plaza',
    tab_market: 'Exchange',
    tab_round: 'Quest',
    tab_backpack: 'Me',
    tab_team: 'Squad',
    tab_leaderboard: 'Rich List',
    tab_profile: 'Me',
    connect_wallet: 'Connect',
    rt_confirm: 'Join Round',
    rt_success: "You're In",
    rt_warmup: 'Pre-Round',
    rt_warmup_rank: 'Early Bird Board',
    rt_market: 'A9 Exchange',
    rt_market_rec: 'Exchange Receipts',
    rt_team_profile: 'Squad Card',
    rt_bind_tg: 'Link TG Group',
    rt_invite: 'Invite & Earn',
    rt_claim: 'Claim Prizes',
    rt_proof: 'Quest Pass',
    rt_renew: 'Auto-Continue',
    rt_ledger: 'Reward Ledger',
    rt_records: 'Quest History',
    rt_settings: 'Settings',
    rt_risk_matrix: 'Safety Shield',
    rt_risk_audit: 'On-Chain Proof',
    rt_rules: 'How to Play'
  }
};

export function t(key) {
  const lang = getLang();
  return DICT[lang]?.[key] || DICT['zh-CN'][key] || key;
}
