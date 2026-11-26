/**
 * A9 任天堂交互轻音效与微触感引擎
 * - 零外部音频资源，纯 Web Audio API 合成：清脆按键、棘轮刻度、升调五声音阶、宝箱弹开、通关盖章
 * - 默认静音，仅在用户主动开启后（localStorage: a9_sound_enabled === '1'）发声
 * - AudioContext 仅在明确用户手势下懒初始化
 * - 精细指针设备的 3D 凭证反光采用 rAF 节流并在切页时干净释放
 */

import { store } from './store.js';
import { isReducedMotion } from './tma.js';

const PENTA_SCALE = [523.25, 587.33, 659.25, 783.99, 880.0, 1046.5, 1174.66, 1318.51];

let audioCtx = null;
let masterBus = null;
let cachedNoiseBuffer = null;
let enabled = Boolean(store.state.settings?.soundEnabled);

function persistSoundPref(flag) {
  store.update((s) => { s.settings.soundEnabled = Boolean(flag); });
  try { localStorage.removeItem('a9_sound_enabled'); } catch (_) {}
}

function ensureCtx() {
  if (!enabled || typeof window === 'undefined') return null;
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return null;
  if (!audioCtx) {
    audioCtx = new Ctx();
    if (typeof audioCtx.createDynamicsCompressor === 'function') {
      const comp = audioCtx.createDynamicsCompressor();
      comp.threshold.setValueAtTime(-16, audioCtx.currentTime);
      comp.knee.setValueAtTime(18, audioCtx.currentTime);
      comp.ratio.setValueAtTime(6, audioCtx.currentTime);
      comp.attack.setValueAtTime(0.004, audioCtx.currentTime);
      comp.release.setValueAtTime(0.14, audioCtx.currentTime);
      const gain = audioCtx.createGain();
      gain.gain.setValueAtTime(0.92, audioCtx.currentTime);
      comp.connect(gain);
      gain.connect(audioCtx.destination);
      masterBus = comp;
    } else {
      masterBus = audioCtx.destination;
    }
  }
  if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
  return audioCtx;
}

function getOutputNode(ctx) {
  return masterBus || ctx.destination;
}

function getNoiseBuffer(ctx) {
  if (cachedNoiseBuffer && cachedNoiseBuffer.sampleRate === ctx.sampleRate) {
    return cachedNoiseBuffer;
  }
  const len = Math.floor(ctx.sampleRate * 0.45);
  const buffer = ctx.createBuffer(1, len, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < len; i++) {
    data[i] = Math.random() * 2 - 1;
  }
  cachedNoiseBuffer = buffer;
  return buffer;
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
    osc.frequency.exponentialRampToValueAtTime(Math.max(20, endFreq), now + duration);
  }
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.linearRampToValueAtTime(peakGain, now + Math.min(0.012, duration * 0.3));
  gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);
  osc.connect(gain);
  gain.connect(getOutputNode(ctx));
  osc.start(now);
  osc.stop(now + duration + 0.03);
}

/** 带通扫频白噪声：模拟 Switch 清脆切页 / 棘轮短擦声 */
function playFilteredNoise(startOffset, duration, startFreq, endFreq, q = 2.2, peakGain = 0.05) {
  const ctx = ensureCtx();
  if (!ctx) return;
  const now = ctx.currentTime + startOffset;
  const src = ctx.createBufferSource();
  src.buffer = getNoiseBuffer(ctx);
  const filter = ctx.createBiquadFilter();
  filter.type = 'bandpass';
  filter.Q.setValueAtTime(q, now);
  filter.frequency.setValueAtTime(startFreq, now);
  filter.frequency.exponentialRampToValueAtTime(Math.max(60, endFreq), now + duration);
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.linearRampToValueAtTime(peakGain, now + Math.min(0.015, duration * 0.25));
  gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);
  src.connect(filter);
  filter.connect(gain);
  gain.connect(getOutputNode(ctx));
  src.start(now);
  src.stop(now + duration + 0.03);
}

export const A9Audio = {
  isEnabled() {
    return enabled;
  },

  toggle() {
    enabled = !enabled;
    persistSoundPref(enabled);
    if (enabled) this.confirm();
    return enabled;
  },

  /** 轻快木琴点击音 */
  tick() {
    playTone(520, 0, 0.07, 'triangle', 0.055, 680);
  },

  /** 底栏切换清脆触感音 */
  tab() {
    playFilteredNoise(0, 0.055, 1100, 2200, 1.8, 0.022);
    playTone(440, 0, 0.06, 'sine', 0.05, 590);
    playTone(660, 0.032, 0.075, 'triangle', 0.045);
  },

  /** 清脆切页声（切页 / 卡片翻面） */
  pageTurn() {
    playFilteredNoise(0, 0.095, 780, 2600, 1.5, 0.042);
    playTone(390, 0.01, 0.055, 'sine', 0.02, 520);
  },

  /** 木质棘轮咔哒声（右滑每经过 10% 刻度触发，音高随 step 1..9 逐级攀升） */
  ratchet(step = 1) {
    const idx = Math.max(1, Math.min(10, Number(step) || 1));
    const baseFreq = 340 + idx * 62;
    playFilteredNoise(0, 0.024, 1600 + idx * 140, 2800 + idx * 150, 3.4, 0.032);
    playTone(baseFreq, 0, 0.036, 'triangle', 0.052, baseFreq * 1.18);
  },

  /** 卡片 360° 翻转跳起音 */
  flip() {
    playFilteredNoise(0, 0.08, 900, 2400, 1.6, 0.032);
    playTone(340, 0, 0.09, 'triangle', 0.052, 620);
    playTone(780, 0.058, 0.11, 'sine', 0.045, 980);
  },

  /** 任天堂升调五声音阶（按已达标时段数递增音阶，≥8 奏三音达标琶音） */
  scaleChime(passedCount = 1) {
    const n = Math.max(0, Number(passedCount) || 0);
    const note = PENTA_SCALE[Math.min(PENTA_SCALE.length - 1, Math.floor(n / 2))];
    playTone(170, 0, 0.055, 'sine', 0.06, 86);
    playTone(note, 0.03, 0.13, 'triangle', 0.058);
    if (n >= 8) {
      playTone(1046.5, 0.09, 0.14, 'triangle', 0.055);
      playTone(1318.51, 0.16, 0.22, 'triangle', 0.065);
    }
  },

  /** 橡皮圆章盖下 + 达标小和弦 */
  stamp() {
    playFilteredNoise(0, 0.045, 420, 980, 1.8, 0.036);
    playTone(180, 0, 0.07, 'sine', 0.078, 86);
    playTone(587.33, 0.045, 0.12, 'triangle', 0.055);
    playTone(880.0, 0.095, 0.16, 'triangle', 0.055);
  },

  /** 印章盖落音效（参与成功页出征盖章） */
  sealSlam() {
    playFilteredNoise(0, 0.065, 320, 860, 1.4, 0.058);
    playTone(165, 0, 0.11, 'sine', 0.095, 52);
    playTone(523.25, 0.075, 0.11, 'triangle', 0.052);
    playTone(783.99, 0.14, 0.18, 'triangle', 0.058);
  },

  /** 任天堂宝箱弹开 + 金币三连叮铃（通用快捷音） */
  chestOpen() {
    playFilteredNoise(0, 0.075, 900, 2800, 1.6, 0.046);
    playTone(260, 0, 0.07, 'triangle', 0.06, 480);
    playTone(987.77, 0.055, 0.11, 'triangle', 0.065);
    playTone(1318.51, 0.13, 0.13, 'triangle', 0.072);
    playTone(1567.98, 0.21, 0.26, 'sine', 0.068);
  },

  /** 宝箱天降砸台音效（按 6 档重量分级） */
  chestDropSlam(tierId = 'gold') {
    const weights = { bronze: 0.75, silver: 0.85, gold: 0.95, platinum: 1.05, diamond: 1.15, legendary: 1.35 };
    const weight = weights[tierId] || 0.95;
    playTone(175 / weight, 0.22, 0.14 * weight, 'sine', 0.14 * Math.min(1.2, weight), 40);
    playFilteredNoise(0.22, 0.08, 300, 950, 1.5, 0.05 * Math.min(1.3, weight));
    if (tierId === 'legendary' || tierId === 'diamond') {
      playTone(880, 0.24, 0.14, 'triangle', 0.035, 1320);
    }
  },

  /** 连敲破封阶梯升调 + 裂锁金属声 + 渗出前导金币脆响 */
  chestTapStrike(step = 1, tierId = 'gold', leakCoins = 1) {
    const ladder = [440, 523.25, 659.25, 783.99];
    const idx = Math.max(1, Math.min(ladder.length, Number(step) || 1));
    const baseF = ladder[idx - 1];
    playTone(185 + idx * 24, 0, 0.09, 'sine', 0.15, 66);
    playFilteredNoise(0, 0.045, 1600 + idx * 480, 3800 + idx * 350, 3.2, 0.065);
    playTone(baseF, 0.014, 0.13, 'triangle', 0.09);
    playTone(baseF * 1.189, 0.072, 0.16, 'triangle', 0.092);
    const leaks = Math.max(1, Math.min(3, Number(leakCoins) || 1));
    for (let i = 0; i < leaks; i++) {
      playTone(1760 + i * 260, 0.06 + i * 0.045, 0.08, 'sine', 0.035, 2240 + i * 220);
    }
    if (tierId === 'legendary' || tierId === 'diamond') {
      playTone(baseF * 0.5, 0.01, 0.18, 'sawtooth', 0.042);
    }
  },

  /** 前 5% 手气爆棚假动作逆转金光过载音效 */
  chestFakeoutUpgrade() {
    playFilteredNoise(0, 0.14, 850, 5000, 2.4, 0.085);
    playTone(330, 0, 0.38, 'sawtooth', 0.08, 1320);
    playTone(880, 0.04, 0.10, 'square', 0.05);
    playTone(1318.5, 0.14, 0.14, 'square', 0.058);
    playTone(1760, 0.24, 0.18, 'triangle', 0.095);
  },

  /** 6 档专属破封凯旋号角 + 与真实金币数强绑定的 3D 金币瀑布碰撞雨 */
  chestGrandBurst(tierId = 'gold', isJackpot = false, actualCoins = 28) {
    const isEpic = tierId === 'legendary';
    const coinCount = Math.max(4, Number(actualCoins) || 14);
    playTone(isEpic ? 136 : 168, 0, isEpic ? 0.42 : 0.24, 'sine', isEpic ? 0.28 : 0.17, 30);
    playFilteredNoise(0, 0.18, 420, 4800, 1.2, isEpic ? 0.13 : 0.075);
    playTone(2100, 0.01, 0.06, 'square', 0.042, 3400);

    // 金币碰撞声的密度与持续时长与掉落金币数严格联动
    const soundDrops = Math.min(36, Math.max(4, Math.round(coinCount * 0.26)));
    const rainSpan = coinCount <= 10 ? 0.28 : coinCount <= 30 ? 0.55 : coinCount <= 75 ? 0.95 : 1.55;
    for (let i = 0; i < soundDrops; i++) {
      const d = 0.05 + (i / soundDrops) * rainSpan + Math.random() * 0.025;
      const f = 1420 + (i % 7) * 220 + Math.random() * 140;
      const v = coinCount > 70 ? 0.032 : 0.04;
      playTone(f, d, 0.09, 'sine', v, f * 1.14);
      playTone(f * 1.5, d + 0.012, 0.055, 'triangle', v * 0.6);
    }

    if (isEpic) {
      playTone(130.81, 0.04, 1.15, 'sawtooth', 0.068);
      playTone(196.0, 0.04, 1.15, 'sawtooth', 0.058);
      [
        { f: 523.25, t: 0.05, d: 0.11 }, { f: 587.33, t: 0.15, d: 0.11 },
        { f: 659.25, t: 0.25, d: 0.11 }, { f: 783.99, t: 0.35, d: 0.15 },
        { f: 1046.5, t: 0.49, d: 0.92 }, { f: 1318.5, t: 0.49, d: 0.92 }, { f: 1567.98, t: 0.53, d: 0.92 },
      ].forEach((n) => playTone(n.f, n.t, n.d, 'triangle', 0.115));
    } else if (tierId === 'diamond') {
      [587.33, 739.99, 880, 1174.66, 1479.98, 1760, 2349.32].forEach((f, idx) =>
        playTone(f, 0.04 + idx * 0.058, idx === 6 ? 0.72 : 0.20, idx % 2 === 0 ? 'triangle' : 'sine', 0.095));
    } else if (tierId === 'platinum') {
      [523.25, 659.25, 783.99, 987.77, 1174.66, 1567.98].forEach((f, idx) =>
        playTone(f, 0.04 + idx * 0.065, idx === 5 ? 0.62 : 0.18, 'triangle', 0.09));
    } else if (tierId === 'gold') {
      [
        { f: 523.25, t: 0.04, d: 0.11 }, { f: 587.33, t: 0.14, d: 0.11 },
        { f: 659.25, t: 0.24, d: 0.12 }, { f: 1046.5, t: 0.36, d: 0.58 },
      ].forEach((n) => playTone(n.f, n.t, n.d, 'triangle', 0.105));
    } else if (tierId === 'silver') {
      playTone(987.77, 0.03, 0.09, 'square', 0.042);
      playTone(1318.51, 0.11, 0.24, 'triangle', 0.095);
      playTone(1567.98, 0.20, 0.34, 'sine', 0.085);
    } else {
      playTone(987.77, 0.02, 0.08, 'square', 0.044);
      playTone(1318.51, 0.09, 0.26, 'triangle', 0.095);
    }

    if (isJackpot && !isEpic) {
      playTone(1567.98, 0.42, 0.45, 'sine', 0.09);
      playTone(2093.0, 0.48, 0.58, 'sine', 0.085);
    }
  },

  /** 两段式加赠合体撞击终音 */
  chestBonusMerge() {
    playTone(1046.5, 0, 0.08, 'triangle', 0.09);
    playTone(1567.98, 0.06, 0.28, 'sine', 0.105);
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
let kineticCards = [];

export function cleanupKineticSurfaces() {
  if (kineticRaf) {
    cancelAnimationFrame(kineticRaf);
    kineticRaf = 0;
  }
  if (kineticAbort) {
    kineticAbort.abort();
    kineticAbort = null;
  }
  for (const card of kineticCards) {
    try {
      card.style.removeProperty('--glare-o');
      card.style.removeProperty('--glare-x');
      card.style.removeProperty('--glare-y');
      card.style.transform = '';
    } catch (_) {}
  }
  kineticCards = [];
}

/** 精细鼠标指针下的典藏卡微倾角反光 */
export function bindKineticSurfaces(root = document) {
  cleanupKineticSurfaces();
  if (isReducedMotion()) return;
  if (!window.matchMedia?.('(hover: hover) and (pointer: fine)').matches) return;

  const cards = root.querySelectorAll('.cert-pass.cert-detail-card');
  if (!cards.length) return;

  kineticCards = Array.from(cards);
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
