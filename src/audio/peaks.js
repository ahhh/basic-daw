// Waveform peak pyramid.
//
// Drawing straight from an AudioBuffer means touching millions of samples per
// frame while scrolling. Instead each asset gets a min/max pyramid built once
// on import: level 0 is 256 samples per bucket, each level above is 4x coarser.
// The renderer picks the level just finer than the pixel width it needs, so a
// redraw costs ~2 buckets per pixel regardless of zoom.

const BASE_SPB = 256;
const LEVELS = 5;

/** Build the pyramid off the main thread's critical path, yielding as it goes. */
export async function buildPeaks(buffer, onProgress) {
  const numCh = buffer.numberOfChannels;
  const chans = Array.from({ length: numCh }, (_, i) => buffer.getChannelData(i));
  const frames = buffer.length;
  const baseCount = Math.max(1, Math.ceil(frames / BASE_SPB));

  const min = new Float32Array(baseCount);
  const max = new Float32Array(baseCount);
  let overallPeak = 0;
  let sumSq = 0;

  const CHUNK = 4096; // buckets per slice of work
  for (let b = 0; b < baseCount; b += CHUNK) {
    const stop = Math.min(baseCount, b + CHUNK);
    for (let i = b; i < stop; i++) {
      const s0 = i * BASE_SPB;
      const s1 = Math.min(frames, s0 + BASE_SPB);
      let lo = 0;
      let hi = 0;
      for (let s = s0; s < s1; s++) {
        let v = 0;
        for (let c = 0; c < numCh; c++) v += chans[c][s];
        v /= numCh;
        if (v < lo) lo = v;
        if (v > hi) hi = v;
        sumSq += v * v;
      }
      min[i] = lo;
      max[i] = hi;
      const p = Math.max(Math.abs(lo), Math.abs(hi));
      if (p > overallPeak) overallPeak = p;
    }
    if (onProgress) onProgress(stop / baseCount);
    // Let the browser breathe: a 10-minute stereo stem is ~2.5M buckets.
    if (stop < baseCount) await new Promise((r) => setTimeout(r, 0));
  }

  const levels = [{ spb: BASE_SPB, min, max }];
  for (let l = 1; l < LEVELS; l++) {
    const prev = levels[l - 1];
    const count = Math.max(1, Math.ceil(prev.min.length / 4));
    const lmin = new Float32Array(count);
    const lmax = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      let lo = 0;
      let hi = 0;
      for (let k = i * 4; k < Math.min(prev.min.length, i * 4 + 4); k++) {
        if (prev.min[k] < lo) lo = prev.min[k];
        if (prev.max[k] > hi) hi = prev.max[k];
      }
      lmin[i] = lo;
      lmax[i] = hi;
    }
    levels.push({ spb: prev.spb * 4, min: lmin, max: lmax });
    if (count <= 2) break;
  }

  return {
    levels,
    sampleRate: buffer.sampleRate,
    frames,
    peak: overallPeak,
    rms: Math.sqrt(sumSq / Math.max(1, frames)),
  };
}

/** Pick the coarsest level that still has >= 1 bucket per pixel. */
export function pickLevel(peaks, samplesPerPixel) {
  let best = peaks.levels[0];
  for (const lv of peaks.levels) {
    if (lv.spb <= samplesPerPixel) best = lv;
    else break;
  }
  return best;
}

/**
 * Draw a waveform for the sample range [startSample, endSample) into
 * (x, y, w, h). Returns nothing; caller sets fillStyle first.
 */
export function drawPeaks(ctx2d, peaks, startSample, endSample, x, y, w, h) {
  if (w <= 0 || h <= 0 || endSample <= startSample) return;
  const spp = (endSample - startSample) / w;
  const lv = pickLevel(peaks, spp);
  const mid = y + h / 2;
  const half = h / 2;
  const bucketsPerPx = spp / lv.spb;
  const n = lv.min.length;

  ctx2d.beginPath();
  for (let px = 0; px < w; px++) {
    const b0 = (startSample + px * spp) / lv.spb;
    const b1 = b0 + bucketsPerPx;
    let i0 = Math.floor(b0);
    let i1 = Math.max(i0 + 1, Math.ceil(b1));
    if (i1 <= 0 || i0 >= n) continue;
    i0 = Math.max(0, i0);
    i1 = Math.min(n, i1);
    let lo = 0;
    let hi = 0;
    for (let i = i0; i < i1; i++) {
      if (lv.min[i] < lo) lo = lv.min[i];
      if (lv.max[i] > hi) hi = lv.max[i];
    }
    const top = mid - hi * half;
    const bot = mid - lo * half;
    ctx2d.rect(x + px, top, 1, Math.max(1, bot - top));
  }
  ctx2d.fill();
}

/** One-off peaks for tiny previews (pool thumbnails) — no pyramid needed. */
export function quickPeaks(buffer, buckets = 48) {
  const data = buffer.getChannelData(0);
  const step = data.length / buckets;
  const out = new Float32Array(buckets);
  for (let i = 0; i < buckets; i++) {
    const s0 = Math.floor(i * step);
    const s1 = Math.min(data.length, Math.floor(s0 + step));
    let peak = 0;
    for (let s = s0; s < s1; s += 8) {
      const a = Math.abs(data[s]);
      if (a > peak) peak = a;
    }
    out[i] = peak;
  }
  return out;
}
