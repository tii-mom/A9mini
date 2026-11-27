/**
 * A9 Lightweight Real-Time Bilingual Engine (zh-CN / en-US + 8-Language Registry)
 * Strictly aligned to official A9 terminology: 广场 / 闯关 / 战队 / 我的
 */

import { store } from './store.js';
import { config } from './config.js';

export const LANGUAGES = [
  { code: 'zh-CN', label: '简体中文', sub: 'Chinese (Simplified)' },
  { code: 'en-US', label: 'English', sub: 'English (US)' }
];

export function getLang() {
  return store.state.settings.language === 'zh-CN' ? 'zh-CN' : 'en-US';
}

export function L(zh, en) {
  return getLang() === 'en-US' ? en : zh;
}

export function syncDocumentLang(routeTitle) {
  const lang = getLang();
  if (typeof document !== 'undefined') {
    document.documentElement.lang = lang;
    const isTestnet = (store.state.round?.protocolConfig?.network || config.network) === 'testnet';
    const prefix = isTestnet ? '[Testnet] ' : '';
    const brand = lang === 'en-US' ? 'A9 · Wealth Quest' : 'A9 · 财富大冒险';
    document.title = routeTitle ? `${prefix}${routeTitle} · A9` : `${prefix}${brand}`;
  }
}

export function initAutoLanguage() {
  try {
    const saved = localStorage.getItem('a9_ui_prefs_v1');
    const savedLang = saved && JSON.parse(saved)?.settings?.language;
    if (savedLang) {
      if (savedLang !== 'zh-CN' && savedLang !== 'en-US') {
        store.update(s => { s.settings.language = 'en-US'; });
      }
      syncDocumentLang();
      return;
    }
  } catch (_) {}
  const tgLang = window.Telegram?.WebApp?.initDataUnsafe?.user?.language_code || navigator.language || '';
  if (tgLang && !tgLang.toLowerCase().startsWith('zh')) {
    store.update(s => { s.settings.language = 'en-US'; });
  }
  syncDocumentLang();
}

export function toggleLang() {
  const next = getLang() === 'zh-CN' ? 'en-US' : 'zh-CN';
  store.update(s => { s.settings.language = next; });
  syncDocumentLang();
  return next;
}

const DICT = {
  'zh-CN': {
    tab_challenge: '广场',
    tab_market: '宝箱商城',
    tab_round: '闯关',
    tab_backpack: '我的',
    tab_team: '战队',
    tab_leaderboard: '财富榜',
    tab_profile: '我的',
    connect_wallet: '连接钱包',
    rt_confirm: '入场确认',
    rt_success: '入场成功',
    rt_warmup: '开局预热',
    rt_warmup_rank: '预热先锋榜',
    rt_market: '宝箱商城',
    rt_market_rec: '宝箱小票',
    rt_team_profile: '战队名片',
    rt_bind_tg: '绑定 TG 群',
    rt_invite: '邀友赢奖',
    rt_claim: '金库领奖',
    rt_proof: '闯关凭证',
    rt_renew: '开盘提醒',
    rt_ledger: '收益账本',
    rt_records: '闯关战绩',
    rt_settings: '提醒与设置',
    rt_risk_matrix: '安全护盾',
    rt_risk_audit: '链上验真',
    rt_rules: '闯关指南'
  },
  'en-US': {
    tab_challenge: 'Plaza',
    tab_market: 'Chest Mall',
    tab_round: 'Quest',
    tab_backpack: 'Me',
    tab_team: 'Squad',
    tab_leaderboard: 'Rich List',
    tab_profile: 'Me',
    connect_wallet: 'Connect',
    rt_confirm: 'Join Round',
    rt_success: "You're In",
    rt_warmup: 'Pre-Round',
    rt_warmup_rank: 'Warm-Up Board',
    rt_market: 'Chest Mall',
    rt_market_rec: 'Chest Receipts',
    rt_team_profile: 'Squad Card',
    rt_bind_tg: 'Link TG Group',
    rt_invite: 'Invite & Earn',
    rt_claim: 'Claim Prizes',
    rt_proof: 'Quest Pass',
    rt_renew: 'Opening Alerts',
    rt_ledger: 'Reward Ledger',
    rt_records: 'Quest History',
    rt_settings: 'Alerts & Settings',
    rt_risk_matrix: 'Safety Shield',
    rt_risk_audit: 'On-Chain Proof',
    rt_rules: 'How to Play'
  }
};

export function t(key) {
  const lang = getLang();
  return DICT[lang]?.[key] || DICT['zh-CN'][key] || key;
}
