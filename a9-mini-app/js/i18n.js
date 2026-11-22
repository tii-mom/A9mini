/**
 * A9 Lightweight Real-Time Bilingual Engine (zh-CN / en-US + 8-Language Registry)
 * Strictly aligned to official A9 terminology: 挑战 / 团队 / 榜单 / 我的
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
    tab_challenge: '主城',
    tab_market: '商行',
    tab_team: '商会',
    tab_leaderboard: '榜单',
    tab_profile: '资产库',
    connect_wallet: '连接钱包',
    rt_confirm: '参与确认',
    rt_success: '参与成功',
    rt_warmup: '预热',
    rt_warmup_rank: '预热榜',
    rt_market: '内盘购买',
    rt_market_rec: '内盘记录',
    rt_team_profile: '团队门面',
    rt_bind_tg: '群绑定',
    rt_invite: '邀请与推广奖励',
    rt_claim: '领取奖励',
    rt_proof: '质押凭证详情',
    rt_renew: '续期管理',
    rt_ledger: '奖励明细',
    rt_records: '参与记录',
    rt_settings: '设置',
    rt_risk_matrix: '风控与状态自检',
    rt_risk_audit: '链上审计',
    rt_rules: '规则说明'
  },
  'en-US': {
    tab_challenge: 'City',
    tab_market: 'Market',
    tab_team: 'Guild',
    tab_leaderboard: 'Rankings',
    tab_profile: 'Vault',
    connect_wallet: 'Connect',
    rt_confirm: 'Confirm Participation',
    rt_success: 'Success',
    rt_warmup: 'Warm-Up',
    rt_warmup_rank: 'Warm-Up Board',
    rt_market: 'Internal Market',
    rt_market_rec: 'Market Records',
    rt_team_profile: 'Team Profile',
    rt_bind_tg: 'Group Binding',
    rt_invite: 'Invite & Rewards',
    rt_claim: 'Claim Rewards',
    rt_proof: 'Certificate Detail',
    rt_renew: 'Renewal',
    rt_ledger: 'Reward Ledger',
    rt_records: 'Participation History',
    rt_settings: 'Settings',
    rt_risk_matrix: 'Risk & States',
    rt_risk_audit: 'On-Chain Audit',
    rt_rules: 'Protocol Rules'
  }
};

export function t(key) {
  const lang = getLang();
  return DICT[lang]?.[key] || DICT['zh-CN'][key] || key;
}
