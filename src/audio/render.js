// Offline bounce. The graph here is assembled with the same `buildChain` used
// for live playback and the same clip envelope maths, so a bounce is the live
// mix rendered faster than real time rather than a second implementation.

import { dbToGain, clamp } from "../util.js";
import { assets, state, trackAudible } from "../state.js";
import { buildChain } from "./effects.js";
import { scheduleClipEnvelope } from "./engine.js";
import { encodeWav } from "./wav.js";

/**
 * Render [start, end) of the project.
 * opts: { sampleRate, trackIds, applyMaster, respectMutes, tailSec, onProgress }
 */
export async function renderRange(start, end, opts = {}) {
  const project = state.project;
  const sampleRate = opts.sampleRate ?? 48000;
  const tail = opts.tailSec ?? 2;
  const duration = Math.max(0.05, end - start + tail);
  const frames = Math.ceil(duration * sampleRate);
  const ctx = new OfflineAudioContext(2, frames, sampleRate);

  const masterIn = ctx.createGain();
  const masterGain = ctx.createGain();
  masterGain.gain.value = opts.applyMaster === false ? 1 : dbToGain(project.master.volumeDb);
  buildChain(ctx, opts.applyMaster === false ? [] : project.master.fx, masterIn, masterGain, true);
  masterGain.connect(ctx.destination);

  const wanted = opts.trackIds ? new Set(opts.trackIds) : null;
  const inputs = new Map();
  for (const track of project.tracks) {
    if (wanted && !wanted.has(track.id)) continue;
    if (opts.respectMutes !== false && !wanted && !trackAudible(track)) continue;
    const input = ctx.createGain();
    const gain = ctx.createGain();
    const pan = ctx.createStereoPanner();
    gain.gain.value = dbToGain(track.volumeDb);
    pan.pan.value = clamp(track.pan, -1, 1);
    buildChain(ctx, track.fx, input, gain, true);
    gain.connect(pan).connect(masterIn);
    inputs.set(track.id, input);
  }

  for (const clip of project.clips) {
    if (clip.mute) continue;
    const input = inputs.get(clip.trackId);
    if (!input) continue;
    const asset = assets.get(clip.assetId);
    if (!asset?.buffer) continue;

    const clipEnd = clip.start + clip.duration;
    if (clipEnd <= start || clip.start >= end) continue;

    const from = Math.max(clip.start, start);
    const until = Math.min(clipEnd, end);
    const when = from - start;

    const effRate = clip.rate * Math.pow(2, (clip.detune || 0) / 1200);
    const src = ctx.createBufferSource();
    src.buffer = clip.reverse ? reverseCopy(ctx, asset.buffer) : asset.buffer;
    src.playbackRate.value = clip.rate;
    if (clip.detune) src.detune.value = clip.detune;

    const g = ctx.createGain();
    scheduleClipEnvelope(g.gain, clip, from, until, when);
    src.connect(g).connect(input);

    const srcOffset = clamp(clip.offset + (from - clip.start) * effRate, 0, src.buffer.duration);
    const playSecs = until - from;
    src.start(when, srcOffset, Math.min(playSecs * effRate, src.buffer.duration - srcOffset));
  }

  if (opts.onProgress) trackProgress(ctx, duration, opts.onProgress);
  const rendered = await ctx.startRendering();
  return rendered;
}

/** OfflineAudioContext has no progress event; suspend at intervals to fake one. */
function trackProgress(ctx, duration, onProgress) {
  const steps = 20;
  for (let i = 1; i < steps; i++) {
    const at = (duration * i) / steps;
    ctx.suspend(at).then(() => {
      onProgress(i / steps);
      ctx.resume();
    });
  }
}

function reverseCopy(ctx, buffer) {
  const out = ctx.createBuffer(buffer.numberOfChannels, buffer.length, buffer.sampleRate);
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const from = buffer.getChannelData(c);
    const to = out.getChannelData(c);
    for (let i = 0, n = from.length; i < n; i++) to[i] = from[n - 1 - i];
  }
  return out;
}

/** Peak-normalize in place to `targetDb`, returning the gain that was applied. */
export function normalizeBuffer(buffer, targetDb = -0.3) {
  let peak = 0;
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const d = buffer.getChannelData(c);
    for (let i = 0; i < d.length; i++) {
      const a = Math.abs(d[i]);
      if (a > peak) peak = a;
    }
  }
  if (peak <= 0) return 1;
  const g = dbToGain(targetDb) / peak;
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const d = buffer.getChannelData(c);
    for (let i = 0; i < d.length; i++) d[i] *= g;
  }
  return g;
}

export function bufferToWavBlob(buffer, bits = 24) {
  return encodeWav(buffer, bits);
}

/** True peak (well, sample peak) and RMS of a rendered buffer, in dB. */
export function analyzeBuffer(buffer) {
  let peak = 0;
  let sumSq = 0;
  let n = 0;
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const d = buffer.getChannelData(c);
    for (let i = 0; i < d.length; i++) {
      const a = Math.abs(d[i]);
      if (a > peak) peak = a;
      sumSq += d[i] * d[i];
      n++;
    }
  }
  const rms = Math.sqrt(sumSq / Math.max(1, n));
  return {
    peakDb: peak > 0 ? 20 * Math.log10(peak) : -Infinity,
    rmsDb: rms > 0 ? 20 * Math.log10(rms) : -Infinity,
  };
}
