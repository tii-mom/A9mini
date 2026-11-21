/**
 * A9 Multimodal Sensory Engine (Engineering Spec v2)
 * - Sound defaults to MUTED unless user explicitly enabled it in localStorage
 * - AudioContext is lazily initialized strictly on explicit user gesture
 * - 3D specular glare is restricted to fine-pointer hover devices using rAF
 * - Clean teardown on route change / page hide
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

  /** Short 14ms mechanical click for explicit confirmations / threshold crossing */
  tick() {
    const ctx = ensureCtx();
    if (!ctx) return;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(720, now);
    osc.frequency.exponentialRampToValueAtTime(340, now + 0.015);
    gain.gain.setValueAtTime(0.04, now);
    gain.gain.exponentialRampToValueAtTime(0.0008, now + 0.017);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.019);
  },

  /** Crisp two-note confirmation chime for completed submit / theme / enable */
  confirm() {
    const ctx = ensureCtx();
    if (!ctx) return;
    const now = ctx.currentTime;
    [523.25, 783.99].forEach((freq, i) => {
      const t = now + i * 0.05;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, t);
      gain.gain.setValueAtTime(0.001, t);
      gain.gain.linearRampToValueAtTime(0.055, t + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0008, t + 0.19);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(t);
      osc.stop(t + 0.21);
    });
  },

  /** Muted low double-thud for validation / transaction failure */
  error() {
    const ctx = ensureCtx();
    if (!ctx) return;
    const now = ctx.currentTime;
    [0, 0.07].forEach((offset) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(185, now + offset);
      osc.frequency.exponentialRampToValueAtTime(115, now + offset + 0.055);
      gain.gain.setValueAtTime(0.05, now + offset);
      gain.gain.exponentialRampToValueAtTime(0.0008, now + offset + 0.06);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now + offset);
      osc.stop(now + offset + 0.065);
    });
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

/**
 * Fine-pointer hover-only 3D tilt & specular glare strictly for VIP Black Certificate Detail cards.
 * Disabled on touchscreens and when prefers-reduced-motion is enabled.
 */
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
