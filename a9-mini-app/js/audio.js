/**
 * A9 任天堂手工纸艺轻音效与微触感引擎
 * - 默认静音，仅在用户主动开启后（localStorage: a9_sound_enabled === '1'）发声
 * - AudioContext 仅在明确手势下懒初始化
 * - 精细指针设备的 3D 凭证反光采用 rAF 节流并在切页时干净释放
 */

const SOUND_KEY = 'a9_sound_enabled';

let audioCtx = null;
let enabled = (() => {
  try {
    return localStorage.getItem(SOUND_KEY) === '1';
  } catch (_) {
    return false;
  }
})();

function ensureCtx() {
  if (!enabled || typeof window === 'undefined') return null;
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return null;
  if (!audioCtx) audioCtx = new Ctx();
  if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
  return audioCtx;
}

function playTone(freq, startOffset, duration, type = 'triangle', peakGain = 0.065, endFreq = null) {
  const ctx = ensureCtx();
  if (!ctx) return;
  const now = ctx.currentTime + startOffset;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, now);
  if (endFreq !== null) {
    osc.frequency.exponentialRampToValueAtTime(endFreq, now + duration);
  }
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.linearRampToValueAtTime(peakGain, now + 0.012);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start(now);
  osc.stop(now + duration + 0.02);
}

export const A9Audio = {
  isEnabled() {
    return enabled;
  },

  toggle() {
    enabled = !enabled;
    try { localStorage.setItem(SOUND_KEY, enabled ? '1' : '0'); } catch (_) {}
    if (enabled) this.confirm();
    return enabled;
  },

  /** 轻快木琴点击音 */
  tick() {
    playTone(520, 0, 0.075, 'triangle', 0.06, 680);
  },

  /** 底栏切换圆润啵声 */
  tab() {
    playTone(440, 0, 0.06, 'sine', 0.055, 590);
    playTone(660, 0.035, 0.08, 'triangle', 0.048);
  },

  /** 纸片 360° 翻身跳起音 */
  flip() {
    playTone(340, 0, 0.09, 'triangle', 0.055, 620);
    playTone(780, 0.06, 0.11, 'sine', 0.048, 980);
  },

  /** 橡皮圆章盖下 + 达标小和弦 */
  stamp() {
    playTone(180, 0, 0.07, 'sine', 0.08, 92);
    playTone(587.33, 0.045, 0.12, 'triangle', 0.055);
    playTone(880.0, 0.095, 0.16, 'triangle', 0.055);
  },

  /** 任天堂双音金币叮铃（提交/领取/开启确认） */
  confirm() {
    playTone(987.77, 0, 0.085, 'triangle', 0.065);
    playTone(1318.51, 0.075, 0.22, 'triangle', 0.072);
  },

  /** 柔和双低音提示（校验失败/异常） */
  error() {
    playTone(185, 0, 0.055, 'sine', 0.05, 115);
    playTone(170, 0.07, 0.06, 'sine', 0.05, 105);
  }
};

let kineticAbort = null;
let kineticRaf = 0;

export function cleanupKineticSurfaces() {
  if (kineticRaf) {
    cancelAnimationFrame(kineticRaf);
    kineticRaf = 0;
  }
  if (kineticAbort) {
    kineticAbort.abort();
    kineticAbort = null;
  }
}

/** 精细鼠标指针下的典藏卡微倾角反光 */
export function bindKineticSurfaces(root = document) {
  cleanupKineticSurfaces();
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
  if (!window.matchMedia?.('(hover: hover) and (pointer: fine)').matches) return;

  const cards = root.querySelectorAll('.cert-pass.cert-detail-card');
  if (!cards.length) return;

  kineticAbort = new AbortController();
  const { signal } = kineticAbort;

  cards.forEach((card) => {
    card.classList.add('kinetic-card');
    let cachedRect = null;
    let pendingX = 0;
    let pendingY = 0;

    const onEnter = () => {
      cachedRect = card.getBoundingClientRect();
    };

    const onMove = (e) => {
      if (e.pointerType && e.pointerType !== 'mouse' && e.pointerType !== 'pen') return;
      if (!cachedRect) cachedRect = card.getBoundingClientRect();
      pendingX = e.clientX;
      pendingY = e.clientY;
      if (kineticRaf) return;
      kineticRaf = requestAnimationFrame(() => {
        kineticRaf = 0;
        if (!cachedRect || !cachedRect.width || !cachedRect.height) return;
        const px = Math.max(0, Math.min(1, (pendingX - cachedRect.left) / cachedRect.width));
        const py = Math.max(0, Math.min(1, (pendingY - cachedRect.top) / cachedRect.height));
        const rotY = (px - 0.5) * 4.5;
        const rotX = (0.5 - py) * 3.5;
        card.style.setProperty('--glare-x', `${(px * 100).toFixed(1)}%`);
        card.style.setProperty('--glare-y', `${(py * 100).toFixed(1)}%`);
        card.style.setProperty('--glare-o', '1');
        card.style.transform = `perspective(900px) rotateX(${rotX.toFixed(2)}deg) rotateY(${rotY.toFixed(2)}deg) translateZ(0)`;
      });
    };

    const onLeave = () => {
      cachedRect = null;
      if (kineticRaf) {
        cancelAnimationFrame(kineticRaf);
        kineticRaf = 0;
      }
      card.style.setProperty('--glare-o', '0');
      card.style.transform = 'perspective(900px) rotateX(0deg) rotateY(0deg) translateZ(0)';
    };

    card.addEventListener('pointerenter', onEnter, { passive: true, signal });
    card.addEventListener('pointermove', onMove, { passive: true, signal });
    card.addEventListener('pointerleave', onLeave, { passive: true, signal });
  });
}

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && kineticRaf) {
      cancelAnimationFrame(kineticRaf);
      kineticRaf = 0;
    }
  });
}
