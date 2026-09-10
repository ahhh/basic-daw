// Insert effects, built from native Web Audio nodes only.
//
// Native-only is a deliberate constraint: the exact same `createEffect` code
// runs inside an OfflineAudioContext during bounce, so what you hear is what
// you render — no worklet module loading, no sample-rate surprises.
//
// Every effect exposes {input, output, update(def), dispose()}. `update` is
// called on every parameter tweak, so it must be cheap and click-free.

import { uid, clamp, dbToGain } from "../util.js";

/** Parameter schema drives the whole inspector UI — no per-effect markup. */
export const EFFECT_DEFS = {
  eq: {
    label: "EQ (4-band)",
    params: [
      { key: "lowFreq", label: "Low F", min: 20, max: 1000, def: 120, unit: "Hz", log: true },
      { key: "lowGain", label: "Low", min: -18, max: 18, def: 0, unit: "dB" },
      { key: "midFreq", label: "Mid F", min: 100, max: 8000, def: 800, unit: "Hz", log: true },
      { key: "midGain", label: "Mid", min: -18, max: 18, def: 0, unit: "dB" },
      { key: "midQ", label: "Mid Q", min: 0.2, max: 8, def: 1, unit: "" },
      { key: "hiMidFreq", label: "HiMid F", min: 500, max: 16000, def: 3200, unit: "Hz", log: true },
      { key: "hiMidGain", label: "HiMid", min: -18, max: 18, def: 0, unit: "dB" },
      { key: "hiMidQ", label: "HiMid Q", min: 0.2, max: 8, def: 1, unit: "" },
      { key: "highFreq", label: "High F", min: 1000, max: 20000, def: 8000, unit: "Hz", log: true },
      { key: "highGain", label: "High", min: -18, max: 18, def: 0, unit: "dB" },
    ],
  },
  filter: {
    label: "Filter",
    params: [
      { key: "mode", label: "Mode", choices: ["lowpass", "highpass", "bandpass", "notch"], def: "lowpass" },
      { key: "freq", label: "Cutoff", min: 20, max: 20000, def: 1200, unit: "Hz", log: true },
      { key: "q", label: "Reso", min: 0.1, max: 20, def: 1, unit: "" },
    ],
  },
  comp: {
    label: "Compressor",
    params: [
      { key: "threshold", label: "Thresh", min: -60, max: 0, def: -18, unit: "dB" },
      { key: "ratio", label: "Ratio", min: 1, max: 20, def: 3, unit: ":1" },
      { key: "knee", label: "Knee", min: 0, max: 40, def: 6, unit: "dB" },
      { key: "attack", label: "Attack", min: 0, max: 0.3, def: 0.006, unit: "s", prec: 3 },
      { key: "release", label: "Release", min: 0.01, max: 2, def: 0.18, unit: "s", prec: 3 },
      { key: "makeup", label: "Makeup", min: -12, max: 24, def: 0, unit: "dB" },
    ],
  },
  limiter: {
    label: "Limiter",
    params: [
      { key: "ceiling", label: "Ceiling", min: -12, max: 0, def: -0.3, unit: "dB" },
      { key: "drive", label: "Drive", min: 0, max: 18, def: 0, unit: "dB" },
      { key: "release", label: "Release", min: 0.01, max: 0.5, def: 0.05, unit: "s", prec: 3 },
    ],
  },
  gate: {
    label: "Noise Gate",
    params: [
      { key: "threshold", label: "Thresh", min: -80, max: 0, def: -45, unit: "dB" },
      { key: "attack", label: "Attack", min: 0, max: 0.1, def: 0.002, unit: "s", prec: 3 },
      { key: "release", label: "Release", min: 0.01, max: 1, def: 0.12, unit: "s", prec: 3 },
    ],
  },
  delay: {
    label: "Delay",
    params: [
      { key: "time", label: "Time", min: 0.01, max: 2, def: 0.32, unit: "s", prec: 3 },
      { key: "feedback", label: "Feedback", min: 0, max: 0.95, def: 0.35, unit: "" },
      { key: "damp", label: "Damp", min: 500, max: 18000, def: 6000, unit: "Hz", log: true },
      { key: "pingpong", label: "Ping-pong", bool: true, def: false },
      { key: "mix", label: "Mix", min: 0, max: 1, def: 0.25, unit: "" },
    ],
  },
  reverb: {
    label: "Reverb",
    params: [
      { key: "size", label: "Size", min: 0.2, max: 8, def: 2.2, unit: "s", prec: 2 },
      { key: "decay", label: "Decay", min: 0.5, max: 8, def: 2.4, unit: "" },
      { key: "damp", label: "Damp", min: 800, max: 18000, def: 5200, unit: "Hz", log: true },
      { key: "predelay", label: "Pre-dly", min: 0, max: 0.2, def: 0.02, unit: "s", prec: 3 },
      { key: "mix", label: "Mix", min: 0, max: 1, def: 0.22, unit: "" },
    ],
  },
  chorus: {
    label: "Chorus",
    params: [
      { key: "rate", label: "Rate", min: 0.05, max: 8, def: 0.6, unit: "Hz", prec: 2 },
      { key: "depth", label: "Depth", min: 0, max: 0.01, def: 0.003, unit: "s", prec: 4 },
      { key: "delay", label: "Delay", min: 0.003, max: 0.05, def: 0.018, unit: "s", prec: 3 },
      { key: "mix", label: "Mix", min: 0, max: 1, def: 0.3, unit: "" },
    ],
  },
  drive: {
    label: "Saturator",
    params: [
      { key: "drive", label: "Drive", min: 1, max: 60, def: 8, unit: "" },
      { key: "tone", label: "Tone", min: 500, max: 18000, def: 9000, unit: "Hz", log: true },
      { key: "mix", label: "Mix", min: 0, max: 1, def: 1, unit: "" },
      { key: "out", label: "Output", min: -24, max: 6, def: -3, unit: "dB" },
    ],
  },
  width: {
    label: "Stereo Width",
    params: [
      { key: "width", label: "Width", min: 0, max: 2, def: 1.2, unit: "" },
      { key: "bassMono", label: "Bass mono", min: 0, max: 400, def: 0, unit: "Hz" },
    ],
  },
  gain: {
    label: "Trim / Gain",
    params: [{ key: "gain", label: "Gain", min: -36, max: 24, def: 0, unit: "dB" }],
  },
};

export function defaultParams(type) {
  const out = {};
  for (const p of EFFECT_DEFS[type].params) out[p.key] = p.def;
  return out;
}

export function newEffect(type) {
  return { id: uid("fx"), type, on: true, params: defaultParams(type) };
}

/* ── helpers ────────────────────────────────────────────────────────────── */

const now = (ctx) => ctx.currentTime;

/** Smooth for live contexts, instant for offline (where currentTime is 0). */
function setParam(ctx, param, value, offline) {
  const v = Number.isFinite(value) ? value : 0;
  if (offline) {
    param.setValueAtTime(v, 0);
  } else {
    const t = now(ctx);
    param.cancelScheduledValues(t);
    param.setValueAtTime(param.value, t);
    param.linearRampToValueAtTime(v, t + 0.02);
  }
}

/** Exponential-decay noise impulse response — cheap, and it sounds like a room. */
export function makeImpulse(ctx, seconds, decay, damp) {
  const len = Math.max(1, Math.floor(ctx.sampleRate * seconds));
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

/**
 * Soft-clip curve for the limiter: unity slope up to `knee`, then a tanh bend
 * that never reaches 1. WaveShaper clamps its lookup to [-1, 1], so the output
 * is hard-bounded — which is what lets the ceiling be an actual guarantee.
 */
const LIMIT_KNEE = 0.7;
/** Largest value the limit curve can emit — the trim divides it out so the
 *  ceiling is hit exactly rather than a fraction of a dB below it. */
const LIMIT_MAX = LIMIT_KNEE + (1 - LIMIT_KNEE) * Math.tanh(1);

function makeLimitCurve(knee = LIMIT_KNEE) {
  const n = 2048;
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    const a = Math.abs(x);
    const y = a <= knee ? a : knee + (1 - knee) * Math.tanh((a - knee) / (1 - knee));
    curve[i] = Math.sign(x) * y;
  }
  return curve;
}

function makeDriveCurve(amount) {
  const n = 2048;
  const curve = new Float32Array(n);
  const k = Math.max(1, amount);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = Math.tanh(k * x) / Math.tanh(k);
  }
  return curve;
}

/* ── effect constructors ────────────────────────────────────────────────── */

const BUILDERS = {
  eq(ctx, offline) {
    const bands = [
      ctx.createBiquadFilter(),
      ctx.createBiquadFilter(),
      ctx.createBiquadFilter(),
      ctx.createBiquadFilter(),
    ];
    bands[0].type = "lowshelf";
    bands[1].type = "peaking";
    bands[2].type = "peaking";
    bands[3].type = "highshelf";
    bands.reduce((a, b) => (a.connect(b), b));
    return {
      input: bands[0],
      output: bands[3],
      bands,
      update(p) {
        setParam(ctx, bands[0].frequency, p.lowFreq, offline);
        setParam(ctx, bands[0].gain, p.lowGain, offline);
        setParam(ctx, bands[1].frequency, p.midFreq, offline);
        setParam(ctx, bands[1].gain, p.midGain, offline);
        setParam(ctx, bands[1].Q, p.midQ, offline);
        setParam(ctx, bands[2].frequency, p.hiMidFreq, offline);
        setParam(ctx, bands[2].gain, p.hiMidGain, offline);
        setParam(ctx, bands[2].Q, p.hiMidQ, offline);
        setParam(ctx, bands[3].frequency, p.highFreq, offline);
        setParam(ctx, bands[3].gain, p.highGain, offline);
      },
    };
  },

  filter(ctx, offline) {
    const f = ctx.createBiquadFilter();
    return {
      input: f,
      output: f,
      node: f,
      update(p) {
        f.type = p.mode ?? "lowpass";
        setParam(ctx, f.frequency, p.freq, offline);
        setParam(ctx, f.Q, p.q, offline);
      },
    };
  },

  comp(ctx, offline) {
    const c = ctx.createDynamicsCompressor();
    const makeup = ctx.createGain();
    c.connect(makeup);
    return {
      input: c,
      output: makeup,
      node: c,
      update(p) {
        setParam(ctx, c.threshold, p.threshold, offline);
        setParam(ctx, c.ratio, p.ratio, offline);
        setParam(ctx, c.knee, p.knee, offline);
        setParam(ctx, c.attack, p.attack, offline);
        setParam(ctx, c.release, p.release, offline);
        setParam(ctx, makeup.gain, dbToGain(p.makeup), offline);
      },
      readout: () => c.reduction,
    };
  },

  limiter(ctx, offline) {
    // Drive into a fast, high-ratio compressor, then trim to the ceiling and
    // clip the last few dB with a soft curve so overs can't escape.
    const drive = ctx.createGain();
    const comp = ctx.createDynamicsCompressor();
    const shaper = ctx.createWaveShaper();
    const out = ctx.createGain();
    shaper.curve = makeLimitCurve();
    drive.connect(comp).connect(shaper).connect(out);
    comp.knee.value = 0;
    comp.ratio.value = 20;
    comp.attack.value = 0.001;
    return {
      input: drive,
      output: out,
      node: comp,
      update(p) {
        setParam(ctx, drive.gain, dbToGain(p.drive), offline);
        setParam(ctx, comp.threshold, clamp(p.ceiling - 2, -60, 0), offline);
        setParam(ctx, comp.release, p.release, offline);
        // The shaper's output is bounded by LIMIT_MAX, so this trim *is* the ceiling.
        setParam(ctx, out.gain, dbToGain(p.ceiling) / LIMIT_MAX, offline);
      },
      readout: () => comp.reduction,
    };
  },

  gate(ctx, offline) {
    // No native gate: track the envelope with an analyser on a side path and
    // drive the gain node from the render loop (engine calls tick()).
    const input = ctx.createGain();
    const vca = ctx.createGain();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    input.connect(vca);
    input.connect(analyser);
    const buf = new Float32Array(analyser.fftSize);
    let open = 0;
    let params = defaultParams("gate");
    return {
      input,
      output: vca,
      needsTick: true,
      update(p) {
        params = p;
      },
      tick(dt) {
        analyser.getFloatTimeDomainData(buf);
        let peak = 0;
        for (let i = 0; i < buf.length; i++) {
          const a = Math.abs(buf[i]);
          if (a > peak) peak = a;
        }
        const target = peak >= dbToGain(params.threshold) ? 1 : 0;
        const tau = target > open ? Math.max(0.001, params.attack) : Math.max(0.005, params.release);
        open += (target - open) * clamp(dt / tau, 0, 1);
        vca.gain.setTargetAtTime(open, ctx.currentTime, 0.005);
      },
      readout: () => open,
    };
  },

  delay(ctx, offline) {
    const input = ctx.createGain();
    const dry = ctx.createGain();
    const wet = ctx.createGain();
    const out = ctx.createGain();
    const dL = ctx.createDelay(2.5);
    const dR = ctx.createDelay(2.5);
    const fbL = ctx.createGain();
    const fbR = ctx.createGain();
    const dampL = ctx.createBiquadFilter();
    const dampR = ctx.createBiquadFilter();
    dampL.type = dampR.type = "lowpass";
    const merger = ctx.createChannelMerger(2);
    input.connect(dry).connect(out);
    input.connect(dL);
    input.connect(dR);
    dL.connect(dampL).connect(fbL);
    dR.connect(dampR).connect(fbR);
    dL.connect(merger, 0, 0);
    dR.connect(merger, 0, 1);
    merger.connect(wet).connect(out);
    let pingpong = false;
    const rewire = (pp) => {
      fbL.disconnect();
      fbR.disconnect();
      if (pp) {
        fbL.connect(dR);
        fbR.connect(dL);
      } else {
        fbL.connect(dL);
        fbR.connect(dR);
      }
      pingpong = pp;
    };
    rewire(false);
    return {
      input,
      output: out,
      update(p) {
        setParam(ctx, dL.delayTime, p.time, offline);
        setParam(ctx, dR.delayTime, p.pingpong ? p.time * 1.0 : p.time * 1.02, offline);
        setParam(ctx, fbL.gain, p.feedback, offline);
        setParam(ctx, fbR.gain, p.feedback, offline);
        setParam(ctx, dampL.frequency, p.damp, offline);
        setParam(ctx, dampR.frequency, p.damp, offline);
        setParam(ctx, wet.gain, p.mix, offline);
        setParam(ctx, dry.gain, 1 - p.mix * 0.4, offline);
        if (!!p.pingpong !== pingpong) rewire(!!p.pingpong);
      },
    };
  },

  reverb(ctx, offline) {
    const input = ctx.createGain();
    const dry = ctx.createGain();
    const wet = ctx.createGain();
    const out = ctx.createGain();
    const pre = ctx.createDelay(0.5);
    const conv = ctx.createConvolver();
    conv.normalize = true;
    input.connect(dry).connect(out);
    input.connect(pre).connect(conv).connect(wet).connect(out);
    let irKey = "";
    return {
      input,
      output: out,
      update(p) {
        const key = `${p.size}|${p.decay}|${p.damp}`;
        if (key !== irKey) {
          conv.buffer = makeImpulse(ctx, p.size, p.decay, p.damp);
          irKey = key;
        }
        setParam(ctx, pre.delayTime, p.predelay, offline);
        setParam(ctx, wet.gain, p.mix, offline);
        setParam(ctx, dry.gain, 1 - p.mix * 0.5, offline);
      },
    };
  },

  chorus(ctx, offline) {
    const input = ctx.createGain();
    const dry = ctx.createGain();
    const wet = ctx.createGain();
    const out = ctx.createGain();
    const dL = ctx.createDelay(0.1);
    const dR = ctx.createDelay(0.1);
    const lfo = ctx.createOscillator();
    const lfo2 = ctx.createOscillator();
    const depthL = ctx.createGain();
    const depthR = ctx.createGain();
    const merger = ctx.createChannelMerger(2);
    lfo.type = lfo2.type = "sine";
    lfo.connect(depthL).connect(dL.delayTime);
    lfo2.connect(depthR).connect(dR.delayTime);
    input.connect(dry).connect(out);
    input.connect(dL).connect(merger, 0, 0);
    input.connect(dR).connect(merger, 0, 1);
    merger.connect(wet).connect(out);
    lfo.start(0);
    // Quarter-cycle offset gives the two voices their stereo spread.
    lfo2.start(0);
    return {
      input,
      output: out,
      update(p) {
        setParam(ctx, lfo.frequency, p.rate, offline);
        setParam(ctx, lfo2.frequency, p.rate * 1.17, offline);
        setParam(ctx, depthL.gain, p.depth, offline);
        setParam(ctx, depthR.gain, -p.depth, offline);
        setParam(ctx, dL.delayTime, p.delay, offline);
        setParam(ctx, dR.delayTime, p.delay * 1.3, offline);
        setParam(ctx, wet.gain, p.mix, offline);
        setParam(ctx, dry.gain, 1 - p.mix * 0.5, offline);
      },
      dispose() {
        try {
          lfo.stop();
          lfo2.stop();
        } catch {
          /* already stopped */
        }
      },
    };
  },

  drive(ctx, offline) {
    const input = ctx.createGain();
    const dry = ctx.createGain();
    const wet = ctx.createGain();
    const shaper = ctx.createWaveShaper();
    const tone = ctx.createBiquadFilter();
    const out = ctx.createGain();
    tone.type = "lowpass";
    shaper.oversample = "4x";
    input.connect(dry).connect(out);
    input.connect(shaper).connect(tone).connect(wet).connect(out);
    let driveKey = -1;
    return {
      input,
      output: out,
      update(p) {
        if (p.drive !== driveKey) {
          shaper.curve = makeDriveCurve(p.drive);
          driveKey = p.drive;
        }
        setParam(ctx, tone.frequency, p.tone, offline);
        setParam(ctx, wet.gain, p.mix, offline);
        setParam(ctx, dry.gain, 1 - p.mix, offline);
        setParam(ctx, out.gain, dbToGain(p.out), offline);
      },
    };
  },

  width(ctx, offline) {
    // Mid/side: M = (L+R)/2, S = (L-R)/2, then L = M+S*w, R = M-S*w.
    // Forcing two channels at the input means a mono source still up-mixes
    // before the split, instead of leaving the right side silent.
    const input = ctx.createGain();
    input.channelCount = 2;
    input.channelCountMode = "explicit";
    input.channelInterpretation = "speakers";
    const splitter = ctx.createChannelSplitter(2);
    const merger = ctx.createChannelMerger(2);
    const mid = ctx.createGain();
    const side = ctx.createGain();
    const sideInvert = ctx.createGain();
    const sideWidth = ctx.createGain();
    const sideHp = ctx.createBiquadFilter();
    const outL = ctx.createGain();
    const outR = ctx.createGain();
    sideHp.type = "highpass";
    sideInvert.gain.value = -1;
    mid.gain.value = 0.5;
    side.gain.value = 0.5;
    input.connect(splitter);
    splitter.connect(mid, 0);
    splitter.connect(mid, 1);
    splitter.connect(side, 0);
    splitter.connect(sideInvert, 1);
    sideInvert.connect(side);
    side.connect(sideHp).connect(sideWidth);
    mid.connect(outL);
    mid.connect(outR);
    sideWidth.connect(outL);
    const negSide = ctx.createGain();
    negSide.gain.value = -1;
    sideWidth.connect(negSide).connect(outR);
    outL.connect(merger, 0, 0);
    outR.connect(merger, 0, 1);
    return {
      input,
      output: merger,
      update(p) {
        setParam(ctx, sideWidth.gain, p.width, offline);
        setParam(ctx, sideHp.frequency, Math.max(10, p.bassMono), offline);
      },
    };
  },

  gain(ctx, offline) {
    const g = ctx.createGain();
    return {
      input: g,
      output: g,
      update(p) {
        setParam(ctx, g.gain, dbToGain(p.gain), offline);
      },
    };
  },
};

/** Instantiate one effect. `offline` selects instant vs. smoothed parameter writes. */
export function createEffect(ctx, def, offline = false) {
  const build = BUILDERS[def.type];
  if (!build) return null;
  const fx = build(ctx, offline);
  fx.type = def.type;
  fx.id = def.id;
  fx.update({ ...defaultParams(def.type), ...def.params });
  return fx;
}

/**
 * Wire `defs` between `input` and `output`, returning live effect handles.
 * Bypassed effects are simply left out of the path (not merely muted), which
 * keeps their CPU cost at zero and their latency out of the sum.
 */
export function buildChain(ctx, defs, input, output, offline = false) {
  const live = [];
  let node = input;
  for (const def of defs ?? []) {
    if (def.on === false) continue;
    const fx = createEffect(ctx, def, offline);
    if (!fx) continue;
    node.connect(fx.input);
    node = fx.output;
    live.push(fx);
  }
  node.connect(output);
  return live;
}

export function disposeChain(live) {
  for (const fx of live ?? []) {
    try {
      fx.dispose?.();
      fx.input.disconnect();
      fx.output.disconnect();
    } catch {
      /* already torn down */
    }
  }
}
