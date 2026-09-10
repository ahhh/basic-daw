// Insert chains.
//
// The effects themselves now live in src/plugins/ — this module is just the
// part the audio graph cares about: wiring a list of effect definitions
// between two nodes, and tearing it down again.
//
// The same `buildChain` runs inside an OfflineAudioContext during bounce, so
// what you hear is what you render. That is the one rule a plugin must not
// break: no state that exists only in the live context, no module loading at
// build time.

import { createEffect } from "../plugins/registry.js";

export { createEffect, newEffect, defaultParams, signatureOf, labelOf, paramsOf, getPlugin, missingPlugins, missingInProject } from "../plugins/registry.js";
export { makeImpulse } from "../plugins/dsp.js";

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
