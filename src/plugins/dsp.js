// Shared DSP primitives: parameter writing, waveshaper curves, impulse
// responses. Both plugin tiers use these, so a JSON plugin's `tanh` curve is
// bit-identical to the built-in saturator's.

import { clamp } from "../util.js";

/**
 * Write an AudioParam. Smooth for live contexts, instant for offline renders
 * (where currentTime is pinned at 0 and a ramp would smear the first 20 ms).
 */
export function setAudioParam(ctx, param, value, offline, smooth = true) {
  const v = Number.isFinite(value) ? value : 0;
  if (offline || !smooth) {
    param.cancelScheduledValues(0);
    param.setValueAtTime(v, offline ? 0 : ctx.currentTime);
    return;
  }
  const t = ctx.currentTime;
  param.cancelScheduledValues(t);
  param.setValueAtTime(param.value, t);
  param.linearRampToValueAtTime(v, t + 0.02);
}

/* ── waveshaper curves ────────────────────────────────────────────────── */

export const LIMIT_KNEE = 0.7;
/** Largest value the soft-clip curve can emit, so a ceiling trim can divide it out. */
export const LIMIT_MAX = LIMIT_KNEE + (1 - LIMIT_KNEE) * Math.tanh(1);

export function makeSoftClipCurve(knee = LIMIT_KNEE, n = 2048) {
  return sample(n, (x) => {
    const a = Math.abs(x);
    return Math.sign(x) * (a <= knee ? a : knee + (1 - knee) * Math.tanh((a - knee) / (1 - knee)));
  });
}

export function makeDriveCurve(amount, n = 2048) {
  const k = Math.max(1, amount);
  return sample(n, (x) => Math.tanh(k * x) / Math.tanh(k));
}

export function makeHardClipCurve(threshold = 1, n = 2048) {
  const t = Math.max(1e-4, threshold);
  return sample(n, (x) => clamp(x, -t, t) / t);
}

export function makeBitCrushCurve(bits = 8, n = 2048) {
  const steps = Math.max(2, Math.pow(2, clamp(bits, 1, 16)));
  return sample(n, (x) => Math.round(x * steps) / steps);
}

/** Wavefolder: reflect back into range instead of clipping. */
export function makeFoldCurve(amount = 1, n = 2048) {
  const k = Math.max(0.01, amount);
  return sample(n, (x) => {
    let v = x * k;
    for (let i = 0; i < 8 && (v > 1 || v < -1); i++) v = v > 1 ? 2 - v : -2 - v;
    return v;
  });
}

export function makeTableCurve(points, n = 2048) {
  const pts = [...points].sort((a, b) => a[0] - b[0]);
  return sample(n, (x) => {
    if (x <= pts[0][0]) return pts[0][1];
    if (x >= pts.at(-1)[0]) return pts.at(-1)[1];
    let i = 0;
    while (i < pts.length - 2 && pts[i + 1][0] < x) i++;
    const [x0, y0] = pts[i];
    const [x1, y1] = pts[i + 1];
    return x1 === x0 ? y0 : y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
  });
}

/** Evaluate `fn(x)` over x ∈ [-1, 1] into a Float32Array of length n. */
export function sample(n, fn) {
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) curve[i] = fn((i / (n - 1)) * 2 - 1);
  return curve;
}

/* ── impulse responses ────────────────────────────────────────────────── */

/** Exponential-decay noise impulse — cheap, and it sounds like a room. */
export function makeImpulse(ctx, seconds, decay, damp) {
  const len = Math.max(1, Math.floor(ctx.sampleRate * clamp(seconds, 0.01, 20)));
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  // One-pole lowpass coefficient for the damping tilt.
  const coef = Math.exp((-2 * Math.PI * damp) / ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const data = buf.getChannelData(ch);
    let z = 0;
    for (let i = 0; i < len; i++) {
      const t = i / len;
      const noise = Math.random() * 2 - 1;
      z = noise * (1 - coef) + z * coef;
      data[i] = z * Math.pow(1 - t, decay);
    }
  }
  return buf;
}

export function makeUnitImpulse(ctx) {
  const buf = ctx.createBuffer(2, 1, ctx.sampleRate);
  buf.getChannelData(0)[0] = 1;
  buf.getChannelData(1)[0] = 1;
  return buf;
}

/** Build an IR from a per-sample expression of `t` (0 → 1) and `noise`. */
export function makeExprImpulse(ctx, seconds, fn, scope) {
  const len = Math.max(1, Math.floor(ctx.sampleRate * clamp(seconds, 0.01, 20)));
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  const s = { ...scope };
  for (let ch = 0; ch < 2; ch++) {
    const data = buf.getChannelData(ch);
    for (let i = 0; i < len; i++) {
      s.t = i / len;
      s.noise = Math.random() * 2 - 1;
      data[i] = clamp(fn(s), -1, 1);
    }
  }
  return buf;
}
