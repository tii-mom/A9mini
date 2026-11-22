/**
 * A9 Telegram Mini App (TMA) Native SDK Bridge & Multimodal Haptic Engine
 * Works natively inside Telegram WebApp and gracefully falls back in standalone browsers.
 */

const getTg = () => (typeof window !== 'undefined' ? window.Telegram?.WebApp : null);

export const A9TMA = {
  isTelegram() {
    const tg = getTg();
    return Boolean(tg && tg.initData && tg.initData.length > 0);
  },

  init() {
    const tg = getTg();
    if (!tg) return;
    try {
      tg.ready();
      tg.expand();
      const theme = document.documentElement.dataset.theme || 'light';
      this.syncTheme(theme);
    } catch (_) {
      // Safe fallback in browser preview
    }
  },

  syncTheme(theme) {
    const bg = theme === 'dark' ? '#201D1B' : '#F5F0E6';
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', bg);
    const tg = getTg();
    if (!tg) return;
    try {
      tg.setHeaderColor?.(bg);
      tg.setBackgroundColor?.(bg);
    } catch (_) {}
  },

  /** 原始 initData（服务端验签用）。非 Telegram 环境返回空串，绝不伪造。 */
  getRawInitData() {
    return this.isTelegram() ? String(getTg().initData) : '';
  },

  /** 仅在真实 Telegram WebApp 环境中返回真实用户，绝不伪造默认 ID */
  getRealTelegramUser() {
    if (!this.isTelegram()) return null;
    const u = getTg()?.initDataUnsafe?.user;
    if (!u?.id) return null;
    return {
      id: String(u.id),
      username: u.username ? `@${u.username}` : (u.first_name || `tg_${u.id}`),
      firstName: u.first_name || ''
    };
  },

  getUser() {
    const real = this.getRealTelegramUser();
    if (real) return real;
    // 非真实 Telegram 环境绝不默认伪造用户 ID（演示模式如需样例由 demo-data.js 提供）。
    return null;
  },

  /**
   * 安全解析 Telegram start_param / URL ?startapp=
   * 仅作只读路由导航与推荐归因解析，不触发任何资金动作；
   * 严格过滤非 [a-zA-Z0-9_-] 字符，防止深链 XSS / 路径注入。
   */
  parseStartParam() {
    const tg = getTg();
    const urlParams = new URLSearchParams(window.location.search);
    const rawParam = String(tg?.initDataUnsafe?.start_param || urlParams.get('startapp') || '').trim().slice(0, 128);
    if (!rawParam) return null;
    const sanitizeToken = (v, maxLen = 64) => String(v || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, maxLen);

    const safeRaw = sanitizeToken(rawParam, 64);
    if (rawParam === 'claim') return { raw: safeRaw, type: 'claim', id: '', ref: '', route: '/claim', scrollTarget: null };
    if (rawParam === 'warmup') return { raw: safeRaw, type: 'warmup', id: '', ref: '', route: '/warmup', scrollTarget: null };
    if (rawParam === 'market') return { raw: safeRaw, type: 'market', id: '', ref: '', route: '/internal/market', scrollTarget: null };

    const parts = rawParam.split('_');
    const type = sanitizeToken(parts[0], 16).toLowerCase();
    const id = sanitizeToken(parts[1], 48);
    const ref = sanitizeToken(parts.slice(2).join('_'), 64);

    if (type === 'bet') return { raw: safeRaw, type, id, ref, route: '/round', scrollTarget: 'prediction' };
    if (type === 'round') return { raw: safeRaw, type, id, ref, route: '/round', scrollTarget: 'prediction' };
    if (type === 'burn') return { raw: safeRaw, type, id, ref, route: '/round', scrollTarget: 'burn' };
    if (type === 'proof') {
      const certId = id ? (id.startsWith('A9-STAKE-') ? id : `A9-STAKE-${id}`) : '';
      return { raw: safeRaw, type, id: certId, ref, route: certId ? `/proof/${certId}` : '/proof', scrollTarget: null };
    }
    if (type === 'invite') return { raw: safeRaw, type, id, ref: ref || id, route: '/team/invite', scrollTarget: null };
    return null;
  },

  getStartRoute() {
    return this.parseStartParam()?.route || null;
  },

  setBackButton(visible, onClick) {
    const tg = getTg();
    if (!tg?.BackButton) return;
    try {
      tg.BackButton.offClick(this._backHandler);
      if (visible && onClick) {
        this._backHandler = onClick;
        tg.BackButton.onClick(onClick);
        tg.BackButton.show();
      } else {
        tg.BackButton.hide();
      }
    } catch (_) {}
  },

  openExternalLink(url) {
    const tg = getTg();
    if (tg?.openLink) {
      try { tg.openLink(url); return; } catch (_) {}
    }
    window.open(url, '_blank', 'noopener,noreferrer');
  },

  shareInvite(link, text) {
    const tg = getTg();
    const shareUrl = `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent(text)}`;
    if (tg?.openTelegramLink) {
      tg.openTelegramLink(shareUrl);
    } else if (navigator.clipboard) {
      navigator.clipboard.writeText(`${text}\n${link}`).catch(() => {});
    }
  },

  /**
   * 安全封装 Telegram WebApp.shareToStory
   * 仅当传入合法公网 HTTPS 光栅图 URL（PNG/JPG，严禁 data:/blob:/svg）且原生 API 可用时直发；
   * 否则走降级闭环：保存 9:16 高清 PNG，由调用方同步复制专属深链并弹 Toast 提示。
   */
  shareToStory({ mediaUrl, text, widgetLink, fallbackCanvas, filename = 'A9-Story-9x16.png' } = {}) {
    const tg = getTg();
    const isValidHttpsRaster = typeof mediaUrl === 'string' && /^https:\/\/.+\.(png|jpe?g)(\?.*)?$/i.test(mediaUrl);
    if (isValidHttpsRaster && typeof tg?.shareToStory === 'function') {
      try {
        const params = {};
        if (text) params.text = text;
        if (widgetLink) params.widget_link = { url: widgetLink, name: 'Open A9' };
        tg.shareToStory(mediaUrl, params);
        return { mode: 'native' };
      } catch (_) {
        // 原生调用异常时无缝回退到本地保存 + 复制链接
      }
    }
    if (fallbackCanvas) {
      try {
        const link = document.createElement('a');
        link.download = filename;
        link.href = fallbackCanvas.toDataURL('image/png');
        link.click();
      } catch (_) {}
    }
    return { mode: 'fallback', widgetLink: widgetLink || '' };
  }
};

function fallbackVib(pattern) {
  try {
    if (!A9TMA.isTelegram() && navigator.vibrate) navigator.vibrate(pattern);
  } catch (_) {}
}

/**
 * A9 Native Haptic Engine (Telegram HapticFeedback + Web Vibration fallback)
 */
export const A9Haptic = {
  light()   { getTg()?.HapticFeedback?.impactOccurred?.('light');  fallbackVib(8); },
  medium()  { getTg()?.HapticFeedback?.impactOccurred?.('medium'); fallbackVib(14); },
  heavy()   { getTg()?.HapticFeedback?.impactOccurred?.('heavy');  fallbackVib(22); },
  tick()    { getTg()?.HapticFeedback?.selectionChanged?.();       fallbackVib(5); },
  success() { getTg()?.HapticFeedback?.notificationOccurred?.('success'); fallbackVib([10, 35, 18]); },
  warning() { getTg()?.HapticFeedback?.notificationOccurred?.('warning'); fallbackVib([14, 30, 14]); },
  error()   { getTg()?.HapticFeedback?.notificationOccurred?.('error');   fallbackVib([18, 40, 18]); }
};
