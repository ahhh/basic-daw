// Getting plugins into the registry: the ones that ship with the app, and the
// ones you add yourself.
//
// User plugins live in IndexedDB's `meta` store as raw manifests, not as
// compiled objects — so a manifest that stops validating after an app update
// fails loudly at boot with a message, instead of being silently dropped from
// sessions that use it.

import { getMeta, setMeta } from "../storage/db.js";
import { registerBuiltins } from "./builtin.js";
import { loadBundled } from "./bundled/index.js";
import { registerPlugin, unregisterPlugin, getPlugin, allPlugins } from "./registry.js";

const STORE_KEY = "plugins.user";

/** Problems hit while loading, surfaced by the manager rather than thrown. */
export const loadErrors = [];

export async function initPlugins() {
  registerBuiltins();
  const { manifests, errors } = await loadBundled();
  loadErrors.push(...errors);
  for (const manifest of manifests) {
    try {
      registerPlugin(manifest, "bundled");
    } catch (err) {
      loadErrors.push({ id: manifest?.id ?? "?", source: "bundled", message: err.message });
      console.error(err);
    }
  }
  await loadUserPlugins();
  return allPlugins();
}

export async function loadUserPlugins() {
  let saved = [];
  try {
    saved = (await getMeta(STORE_KEY)) ?? [];
  } catch {
    return; // no IndexedDB (private mode, blocked storage) — built-ins still work
  }
  for (const manifest of saved) {
    try {
      registerPlugin(manifest, "user");
    } catch (err) {
      loadErrors.push({ id: manifest?.id ?? "?", source: "user", message: err.message });
      console.error(err);
    }
  }
}

async function persist() {
  const mine = allPlugins()
    .filter((p) => p.source === "user" && p.manifest)
    .map((p) => p.manifest);
  await setMeta(STORE_KEY, mine);
}

/**
 * Parse and install one manifest, or an array of them (a "pack").
 * Returns the installed entries; throws on the first invalid one, having
 * installed nothing, so a bad pack cannot leave the registry half-populated.
 */
export async function installManifest(input, { replace = false } = {}) {
  const parsed = typeof input === "string" ? JSON.parse(input) : input;
  const list = Array.isArray(parsed) ? parsed : [parsed];
  if (!list.length) throw new Error("that file contains no plugins");

  for (const m of list) {
    const existing = getPlugin(m?.id);
    if (existing && existing.source !== "user") {
      throw new Error(`"${m.id}" is a ${existing.source} plugin and cannot be replaced`);
    }
    if (existing && !replace) throw new Error(`"${m.id}" is already installed — reinstall to replace it`);
  }

  // Install all of them or none: a pack whose third manifest is broken must not
  // leave the first two behind, and must not have destroyed what it replaced.
  const replaced = list.map((m) => getPlugin(m.id)?.manifest).filter(Boolean);
  const staged = [];
  try {
    for (const m of list) {
      if (getPlugin(m.id)) unregisterPlugin(m.id);
      staged.push(registerPlugin(m, "user"));
    }
  } catch (err) {
    for (const s of staged) unregisterPlugin(s.id);
    for (const prev of replaced) {
      try {
        registerPlugin(prev, "user");
      } catch {
        /* it validated once; if it no longer does, it is already gone */
      }
    }
    throw err;
  }
  await persist();
  return staged;
}

export async function removeUserPlugin(id) {
  unregisterPlugin(id);
  await persist();
}

export async function installFromFile(file) {
  return installManifest(await file.text(), { replace: true });
}

export async function installFromUrl(url) {
  const res = await fetch(url, { cache: "no-cache" });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return installManifest(await res.text(), { replace: true });
}

/**
 * Load a JS-tier plugin from a URL.
 *
 * This runs the module's code, which JSON plugins deliberately never do — the
 * manager asks before calling it. The module must default-export a plugin spec
 * (or an array of them) with a `create(ctx, offline)` function.
 *
 * JS plugins are not persisted: re-running arbitrary code from a remembered URL
 * at every boot is a bigger promise than this app should make.
 */
export async function installJsModule(url) {
  const mod = await import(/* @vite-ignore */ url);
  const list = [].concat(mod.default ?? []);
  if (!list.length) throw new Error("module has no default export");
  return list.map((spec) => registerPlugin(spec, "user"));
}

/** Export every user plugin as one pack file. */
export function exportUserPack() {
  return allPlugins()
    .filter((p) => p.source === "user" && p.manifest)
    .map((p) => p.manifest);
}
