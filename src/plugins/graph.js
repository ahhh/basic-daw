// The JSON plugin runtime: turn a validated manifest into the same
// {input, output, update, dispose} object the built-in effects return.
//
// Two phases. `compileGraph` is pure — it parses every expression and recipe
// once, at registration, so a bad manifest fails loudly at load rather than
// silently at the first knob move. `instantiate` then builds real nodes; it is
// called once per chain build, including inside OfflineAudioContext, which is
// what keeps a bounce identical to playback.

import { clamp } from "../util.js";
import { compileExpr } from "./expr.js";
import { NODE_TYPES, COMMON_OPTS, parseEndpoint, validateManifest } from "./schema.js";
import {
  setAudioParam,
  makeDriveCurve,
  makeSoftClipCurve,
  makeHardClipCurve,
  makeBitCrushCurve,
  makeFoldCurve,
  makeTableCurve,
  sample,
  makeImpulse,
  makeUnitImpulse,
  makeExprImpulse,
} from "./dsp.js";

/* ── compile ──────────────────────────────────────────────────────────── */

/** Validate and pre-compile a manifest. Throws with every error listed. */
export function compileGraph(manifest) {
  const report = validateManifest(manifest);
  if (!report.ok) {
    throw new Error(`plugin "${manifest?.id ?? "?"}" is invalid:\n  - ${report.errors.join("\n  - ")}`);
  }
  const keys = manifest.params.map((p) => p.key);
  const scope = [...keys, "x"];
  const g = manifest.graph;

  const nodes = {};
  for (const [name, def] of Object.entries(g.nodes)) {
    nodes[name] = { ...def, recipe: compileRecipe(def, scope) };
  }

  const edges = [];
  for (const edge of g.connect) {
    if (Array.isArray(edge)) {
      for (let i = 0; i < edge.length - 1; i++) {
        edges.push({ from: parseEndpoint(edge[i]), to: parseEndpoint(edge[i + 1]), when: null });
      }
    } else {
      edges.push({
        from: parseEndpoint(edge.from),
        to: parseEndpoint(edge.to),
        when: edge.when == null ? null : compileExpr(edge.when, scope),
      });
    }
  }

  const binds = [];
  for (const b of g.bind ?? []) {
    const ep = parseEndpoint(b.to);
    const nodeType = ep.node === "in" || ep.node === "out" ? "gain" : g.nodes[ep.node].type;
    const propSpec = NODE_TYPES[nodeType].props?.[ep.param];
    binds.push({
      node: ep.node,
      target: propSpec ? propSpec.prop : ep.param,
      isProp: !!propSpec,
      param: b.param ?? null,
      fn: b.map != null ? compileExpr(b.map, scope) : null,
      smooth: b.smooth !== false,
    });
  }

  return {
    manifest,
    keys,
    nodes,
    edges,
    binds,
    /** Params whose value changes the *shape* of the graph, not a value in it. */
    rebuildOn: report.rebuildOn,
    warnings: report.warnings,
  };
}

function compileRecipe(def, scope) {
  const rec = def.curve ?? def.ir;
  if (!rec) return null;
  const out = { kind: rec.kind, size: rec.size ?? 2048, fields: {} };
  for (const [k, v] of Object.entries(rec)) {
    if (k === "kind" || k === "size") continue;
    out.fields[k] = k === "points" ? v : compileExpr(v, k === "expr" ? [...scope, "x", "t", "noise"] : scope);
  }
  return out;
}

/* ── instantiate ──────────────────────────────────────────────────────── */

/**
 * Build the graph in `ctx`. Returns the standard effect handle.
 * `offline` selects instant vs. smoothed parameter writes.
 */
export function instantiate(ctx, compiled, offline = false) {
  const made = new Map();
  const started = [];

  const input = ctx.createGain();
  const output = ctx.createGain();
  made.set("in", input);
  made.set("out", output);

  for (const [name, def] of Object.entries(compiled.nodes)) {
    const node = createNode(ctx, def, started);
    for (const k of Object.keys(COMMON_OPTS)) if (def[k] != null) node[k] = def[k];
    made.set(name, node);
  }

  const resolve = (ep) => {
    const node = made.get(ep.node);
    return ep.param ? node[ep.param] : node;
  };

  // Every edge we have actually connected, so rewiring can disconnect exactly
  // what it made and leave the host's connections into `in` and out of `out`
  // untouched.
  let wired = [];

  const wire = (params) => {
    for (const e of wired) {
      try {
        const src = made.get(e.from.node);
        if (e.to.param) src.disconnect(resolve(e.to), e.from.index ?? 0);
        else src.disconnect(resolve(e.to), e.from.index ?? 0, e.to.index ?? 0);
      } catch {
        /* already gone */
      }
    }
    wired = [];
    for (const e of compiled.edges) {
      if (e.when && !e.when(params)) continue;
      const src = made.get(e.from.node);
      if (e.to.param) src.connect(resolve(e.to), e.from.index ?? 0);
      else src.connect(resolve(e.to), e.from.index ?? 0, e.to.index ?? 0);
      wired.push(e);
    }
  };

  const recipeCache = new Map();
  const applyRecipes = (params) => {
    for (const [name, def] of Object.entries(compiled.nodes)) {
      if (!def.recipe) continue;
      const node = made.get(name);
      const resolved = resolveFields(def.recipe, params);
      const key = `${def.recipe.kind}|${def.recipe.size}|${JSON.stringify(resolved)}`;
      if (recipeCache.get(name) === key) continue;
      recipeCache.set(name, key);
      if (def.type === "shaper") node.curve = buildCurve(def.recipe, resolved, params);
      else node.buffer = buildIr(ctx, def.recipe, resolved, params);
    }
  };

  let lastShape = null;
  const handle = {
    input,
    output,
    nodes: made,
    update(params) {
      const shape = compiled.rebuildOn.map((k) => String(params[k])).join("|");
      if (shape !== lastShape) {
        lastShape = shape;
        wire(params);
      }
      applyRecipes(params);
      for (const b of compiled.binds) {
        const node = made.get(b.node);
        const x = b.param ? params[b.param] : 0;
        if (b.isProp) {
          const v = b.param ? params[b.param] : null;
          if (v != null) node[b.target] = v;
          continue;
        }
        const value = b.fn ? b.fn({ ...params, x }) : Number(x);
        setAudioParam(ctx, node[b.target], value, offline, b.smooth);
      }
    },
    dispose() {
      for (const n of started) {
        try {
          n.stop();
        } catch {
          /* already stopped */
        }
      }
      for (const n of made.values()) {
        try {
          n.disconnect();
        } catch {
          /* already torn down */
        }
      }
    },
  };

  // A compressor in the graph gives the plugin a gain-reduction readout for free.
  const comp = [...made.entries()].find(([n]) => compiled.nodes[n]?.type === "compressor");
  if (comp) handle.readout = () => comp[1].reduction;

  return handle;
}

function createNode(ctx, def, started) {
  switch (def.type) {
    case "gain":
      return ctx.createGain();
    case "delay":
      return ctx.createDelay(clamp(def.maxDelay ?? 1, 0.001, 179));
    case "biquad": {
      const n = ctx.createBiquadFilter();
      if (def.filter) n.type = def.filter;
      return n;
    }
    case "osc": {
      const n = ctx.createOscillator();
      if (def.wave) n.type = def.wave;
      if (def.start !== false) {
        n.start(0);
        started.push(n);
      }
      return n;
    }
    case "constant": {
      const n = ctx.createConstantSource();
      if (def.start !== false) {
        n.start(0);
        started.push(n);
      }
      return n;
    }
    case "shaper": {
      const n = ctx.createWaveShaper();
      if (def.oversample) n.oversample = def.oversample;
      return n;
    }
    case "convolver": {
      const n = ctx.createConvolver();
      n.normalize = def.normalize !== false;
      return n;
    }
    case "compressor":
      return ctx.createDynamicsCompressor();
    case "panner":
      return ctx.createStereoPanner();
    case "splitter":
      return ctx.createChannelSplitter(def.channels ?? 2);
    case "merger":
      return ctx.createChannelMerger(def.channels ?? 2);
    case "analyser": {
      const n = ctx.createAnalyser();
      if (def.fftSize) n.fftSize = def.fftSize;
      return n;
    }
    default:
      throw new Error(`unknown node kind "${def.type}"`);
  }
}

function resolveFields(recipe, params) {
  const out = {};
  for (const [k, v] of Object.entries(recipe.fields)) {
    if (k === "expr" || k === "points") continue; // shape, not value — folded into the kind key
    out[k] = v(params);
  }
  // An expression recipe depends on every parameter it reads, and we cannot
  // know which without re-parsing, so key it on all of them.
  if (recipe.fields.expr) out.__params = params;
  return out;
}

function buildCurve(recipe, f, params) {
  const n = recipe.size;
  switch (recipe.kind) {
    case "tanh":
      return makeDriveCurve(f.amount, n);
    case "softclip":
      return makeSoftClipCurve(clamp(f.knee, 0, 0.999), n);
    case "hardclip":
      return makeHardClipCurve(f.threshold, n);
    case "bitcrush":
      return makeBitCrushCurve(f.bits, n);
    case "fold":
      return makeFoldCurve(f.amount, n);
    case "table":
      return makeTableCurve(recipe.fields.points, n);
    case "expr": {
      const fn = recipe.fields.expr;
      const scope = { ...params };
      return sample(n, (x) => {
        scope.x = x;
        return clamp(fn(scope), -1, 1);
      });
    }
    default:
      throw new Error(`unknown curve kind "${recipe.kind}"`);
  }
}

function buildIr(ctx, recipe, f, params) {
  switch (recipe.kind) {
    case "noise-decay":
      return makeImpulse(ctx, f.seconds, f.decay, f.damp);
    case "impulse":
      return makeUnitImpulse(ctx);
    case "expr":
      return makeExprImpulse(ctx, f.seconds, recipe.fields.expr, params);
    default:
      throw new Error(`unknown IR kind "${recipe.kind}"`);
  }
}
