/**
 * A9 任天堂交互轻音效与微触感轻量外观层
 * - 默认静音时不下载/解析 audio-engine.js
 * - 并发加载去重，加载失败自动清理允许重试，绝不阻断业务
 * - 用户手势同步预解锁 AudioContext，避免首次异步加载脱离手势被浏览器拦截
 */

import { store } from './store.js';
import { isReducedMotion } from './tma.js';

let enabled = Boolean(store.state.settings?.soundEnabled);
let engineMod = null;
let enginePromise = null;
let unlockedCtx = null;
let pendingCue = null;
let kineticSeq = 0;
let engineLoader = () => import('./audio-engine.js');

function persistSoundPref(flag) {
  store.update((s) => { s.settings.soundEnabled = Boolean(flag); });
  try { localStorage.removeItem('a9_sound_enabled'); } catch (_) {}
}

/** 在用户手势同步栈内预解锁 AudioContext，供异步引擎复用 */
function primeAudioContextOnGesture() {
  if (!enabled || unlockedCtx || typeof window === 'undefined') return;
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return;
  try {
    unlockedCtx = new Ctx();
    if (unlockedCtx.state === 'suspended') unlockedCtx.resume().catch(() => {});
  } catch (_) {
    unlockedCtx = null;
  }
}

/** 按需加载合成引擎（并发去重，失败后清除以便重试） */
export function loadAudioEngine() {
  if (engineMod) return Promise.resolve(engineMod);
  if (!enginePromise) {
    let raw;
    try { raw = Promise.resolve(engineLoader()); } catch (err) { raw = Promise.reject(err); }
    enginePromise = raw
      .then((mod) => {
        engineMod = mod;
        if (unlockedCtx && typeof mod.attachAudioContext === 'function') {
          mod.attachAudioContext(unlockedCtx);
        }
        return mod;
      })
      .catch(() => {
        enginePromise = null;
        return null;
      });
  }
  return enginePromise;
}

/** 测试专用钩子：替换或重置音频引擎加载器 */
export function __setAudioEngineLoaderForTest(loader) {
  engineMod = null;
  enginePromise = null;
  pendingCue = null;
  engineLoader = typeof loader === 'function' ? loader : () => import('./audio-engine.js');
}

function invokeCue(method, args) {
  if (!enabled) return;
  if (engineMod?.audioSynth?.[method]) {
    try {
      engineMod.audioSynth[method](enabled, ...args);
    } catch (_) {}
    return;
  }
  primeAudioContextOnGesture();
  // 加载期间仅保留最近一次待播提示，避免并发点击堆积重复播放
  const hadPending = Boolean(pendingCue);
  pendingCue = { method, args };
  if (hadPending) return;
  loadAudioEngine().then((mod) => {
    const cue = pendingCue;
    pendingCue = null;
    if (!cue || !enabled || !mod?.audioSynth?.[cue.method]) return;
    try {
      mod.audioSynth[cue.method](enabled, ...cue.args);
    } catch (_) {}
  });
}

export const A9Audio = {
  isEnabled() {
    return enabled;
  },

  toggle() {
    enabled = !enabled;
    persistSoundPref(enabled);
    if (!enabled) {
      pendingCue = null;
    } else {
      this.confirm();
    }
    return enabled;
  },

  tick() { invokeCue('tick', []); },
  tab() { invokeCue('tab', []); },
  pageTurn() { invokeCue('pageTurn', []); },
  ratchet(step = 1) { invokeCue('ratchet', [step]); },
  flip() { invokeCue('flip', []); },
  scaleChime(passedCount = 1) { invokeCue('scaleChime', [passedCount]); },
  stamp() { invokeCue('stamp', []); },
  sealSlam() { invokeCue('sealSlam', []); },
  chestOpen() { invokeCue('chestOpen', []); },
  chestDropSlam(tierId = 'gold') { invokeCue('chestDropSlam', [tierId]); },
  chestTapStrike(step = 1, tierId = 'gold', leakCoins = 1) { invokeCue('chestTapStrike', [step, tierId, leakCoins]); },
  chestFakeoutUpgrade() { invokeCue('chestFakeoutUpgrade', []); },
  chestGrandBurst(tierId = 'gold', isJackpot = false, actualCoins = 28) { invokeCue('chestGrandBurst', [tierId, isJackpot, actualCoins]); },
  chestBonusMerge() { invokeCue('chestBonusMerge', []); },
  confirm() { invokeCue('confirm', []); },
  error() { invokeCue('error', []); }
};

export function cleanupKineticSurfaces() {
  kineticSeq += 1;
  if (engineMod?.cleanupKineticSurfacesImpl) {
    engineMod.cleanupKineticSurfacesImpl();
  }
}

/** 精细鼠标指针下的典藏卡微倾角反光（仅存在目标卡片且支持悬停指针时按需加载） */
export function bindKineticSurfaces(root = document) {
  cleanupKineticSurfaces();
  if (isReducedMotion()) return;
  if (typeof window === 'undefined' || !window.matchMedia?.('(hover: hover) and (pointer: fine)').matches) return;
  const cards = root?.querySelectorAll?.('.cert-pass.cert-detail-card');
  if (!cards?.length) return;
  const seq = kineticSeq;
  if (engineMod?.bindKineticSurfacesImpl) {
    engineMod.bindKineticSurfacesImpl(cards);
    return;
  }
  loadAudioEngine().then((mod) => {
    if (seq !== kineticSeq || !mod?.bindKineticSurfacesImpl) return;
    mod.bindKineticSurfacesImpl(cards);
  });
}
