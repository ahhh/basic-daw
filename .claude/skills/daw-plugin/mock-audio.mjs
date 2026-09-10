// A mock AudioContext, enough of one to build a plugin graph and prove it wires
// up. Node has no Web Audio, and the point of `--build` is to catch the errors
// that static validation cannot see, so the mock is strict where it counts:
// `disconnect` throws if asked to remove a connection that was never made,
// which is how a stale edge left behind by a `when` clause gets caught.

class Param {
  constructor(v = 0) {
    this.value = v;
  }
  setValueAtTime(v) {
    if (!Number.isFinite(v)) throw new Error(`non-finite value written to an AudioParam: ${v}`);
    this.value = v;
    return this;
  }
  linearRampToValueAtTime(v) {
    return this.setValueAtTime(v);
  }
  setTargetAtTime(v) {
    return this.setValueAtTime(v);
  }
  cancelScheduledValues() {
    return this;
  }
}

class Node {
  constructor(kind) {
    this.kind = kind;
    this.edges = [];
  }
  connect(dst, o = 0, i = 0) {
    this.edges.push({ dst, o, i });
    return dst;
  }
  disconnect(dst, o, i) {
    if (dst === undefined) {
      this.edges.length = 0;
      return;
    }
    const before = this.edges.length;
    this.edges = this.edges.filter((e) => !(e.dst === dst && (o === undefined || e.o === o) && (i === undefined || e.i === i)));
    if (before === this.edges.length) throw new Error(`disconnect() on a connection that was never made (${this.kind})`);
  }
}

export class MockAudioContext {
  constructor(sampleRate = 48000) {
    this.sampleRate = sampleRate;
    this.currentTime = 0;
    this.destination = new Node("destination");
  }
  #n(kind, extra = {}) {
    return Object.assign(new Node(kind), extra);
  }
  createGain() {
    return this.#n("gain", { gain: new Param(1) });
  }
  createDelay(max) {
    return this.#n("delay", { delayTime: new Param(0), maxDelayTime: max });
  }
  createBiquadFilter() {
    return this.#n("biquad", {
      type: "lowpass",
      frequency: new Param(350),
      Q: new Param(1),
      gain: new Param(0),
      detune: new Param(0),
    });
  }
  createOscillator() {
    const n = this.#n("osc", { type: "sine", frequency: new Param(440), detune: new Param(0) });
    n.start = () => (n.started = true);
    n.stop = () => (n.stopped = true);
    return n;
  }
  createConstantSource() {
    const n = this.#n("constant", { offset: new Param(1) });
    n.start = () => (n.started = true);
    n.stop = () => (n.stopped = true);
    return n;
  }
  createWaveShaper() {
    return this.#n("shaper", { curve: null, oversample: "none" });
  }
  createConvolver() {
    return this.#n("convolver", { buffer: null, normalize: true });
  }
  createDynamicsCompressor() {
    return this.#n("compressor", {
      threshold: new Param(-24),
      knee: new Param(30),
      ratio: new Param(12),
      attack: new Param(0.003),
      release: new Param(0.25),
      reduction: 0,
    });
  }
  createStereoPanner() {
    return this.#n("panner", { pan: new Param(0) });
  }
  createChannelSplitter(channels = 2) {
    return this.#n("splitter", { channels });
  }
  createChannelMerger(channels = 2) {
    return this.#n("merger", { channels });
  }
  createAnalyser() {
    return this.#n("analyser", { fftSize: 2048, getFloatTimeDomainData() {} });
  }
  createBuffer(channels, length, sampleRate) {
    const data = Array.from({ length: channels }, () => new Float32Array(length));
    return {
      numberOfChannels: channels,
      length,
      sampleRate,
      duration: length / sampleRate,
      getChannelData: (i) => data[i],
    };
  }
}

/** The app's util.js registers DOM listeners at import time; satisfy them. */
export function installDomStubs() {
  globalThis.addEventListener ??= () => {};
  globalThis.removeEventListener ??= () => {};
  globalThis.document ??= {
    querySelector: () => null,
    createElement: () => ({
      style: {},
      dataset: {},
      classList: { add() {}, toggle() {} },
      append() {},
      addEventListener() {},
      setAttribute() {},
    }),
    createTextNode: () => ({ nodeType: 3 }),
  };
}
