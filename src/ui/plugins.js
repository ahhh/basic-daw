// The plugin manager: what is installed, where it came from, and how to add
// more. Reachable from either "+ insert" menu and from the Project menu.

import { dialog, download, el, toast } from "../util.js";
import { bus, state } from "../state.js";
import { engine } from "../audio/engine.js";
import { allPlugins, missingInProject } from "../plugins/registry.js";
import { exportUserPack, installFromFile, installFromUrl, installJsModule, installManifest, loadErrors, removeUserPlugin } from "../plugins/loader.js";

const SOURCE_LABEL = {
  builtin: "Built in",
  bundled: "Bundled JSON",
  user: "Installed",
};

/** Every insert in the project that refers to `id`, so removal can warn. */
function usageCount(id) {
  let n = 0;
  const count = (fx) => (fx ?? []).filter((f) => f.type === id).length;
  for (const t of state.project.tracks) n += count(t.fx);
  return n + count(state.project.master.fx);
}

/**
 * Rebuild chains and repaint after the registry changes.
 *
 * Deliberately not `changed()`: installing a plugin is not an edit to the
 * document, so it must not mark the session dirty or enter the undo history.
 */
function applyRegistryChange() {
  engine.rebuildAllChains();
  bus.emit("tracks");
  bus.emit("mix");
}

export function pluginManager() {
  dialog(
    "Plugins",
    (body) => {
      const list = el("div.plug-list");

      const render = () => {
        list.replaceChildren();

        const missing = missingInProject(state.project);
        if (missing.length) {
          list.append(
            el(
              "div.plug-warn",
              null,
              el("b", null, `${missing.length} plugin${missing.length > 1 ? "s" : ""} used by this project ${missing.length > 1 ? "are" : "is"} not installed:`),
              el("div.a-meta", null, missing.join(", ")),
              el("div.a-meta", null, "Those inserts are passing audio through unchanged. Their settings are preserved."),
            ),
          );
        }

        for (const err of loadErrors) {
          list.append(
            el("div.plug-warn", null, el("b", null, `Failed to load "${err.id}"`), el("pre.fx-dump", null, err.message)),
          );
        }

        const groups = ["builtin", "bundled", "user"];
        for (const source of groups) {
          const items = allPlugins()
            .filter((p) => p.source === source)
            .sort((a, b) => a.name.localeCompare(b.name));
          list.append(el("div.plug-head", null, `${SOURCE_LABEL[source]} · ${items.length}`));
          if (!items.length) {
            list.append(
              el(
                "div.insp-empty",
                null,
                source === "user" ? "Nothing installed yet. Add a manifest below." : "None.",
              ),
            );
            continue;
          }
          for (const p of items) list.append(pluginRow(p, render));
        }
      };

      render();
      body.append(list, addSection(render));
    },
    [
      {
        label: "Export my plugins",
        onClick: () => {
          const pack = exportUserPack();
          if (!pack.length) {
            toast("No installed plugins to export", "err");
            return false;
          }
          download(new Blob([JSON.stringify(pack, null, 2)], { type: "application/json" }), "daw-plugins.json");
          return false;
        },
      },
      { label: "Close", primary: true },
    ],
  );
}

function pluginRow(p, refresh) {
  const used = usageCount(p.id);
  const badges = el(
    "div.a-meta",
    null,
    [p.category, p.kind === "json" ? "JSON" : "JS", `${p.params.length} param${p.params.length === 1 ? "" : "s"}`, used ? `${used} in use` : null]
      .filter(Boolean)
      .join(" · "),
  );

  const actions = el("div.plug-actions");
  if (p.manifest) {
    actions.append(
      el("button.btn.small", {
        textContent: "Manifest",
        onclick: () => showManifest(p),
      }),
    );
  }
  if (p.source === "user") {
    actions.append(
      el("button.btn.small.warn", {
        textContent: "Remove",
        onclick: async () => {
          if (used && !confirm(`"${p.name}" is used by ${used} insert${used > 1 ? "s" : ""}. Remove it anyway?\n\nThose inserts will pass audio through until it is reinstalled.`)) return;
          await removeUserPlugin(p.id);
          applyRegistryChange();
          refresh();
          toast(`Removed ${p.name}`, "ok");
        },
      }),
    );
  }

  return el(
    "div.plug-row",
    null,
    el("div.grow", null, el("b", null, p.name), el("code.plug-id", null, p.id), badges, p.description ? el("div.a-meta", null, p.description) : null),
    actions,
  );
}

/** Read-only manifest view. Copy it and you have a starting point for your own. */
function showManifest(p) {
  const text = JSON.stringify(p.manifest, null, 2);
  dialog(
    p.name,
    (b) => {
      b.append(
        el("div.insp-empty", null, "Copy this as a starting point for your own plugin — change the id, then install it below."),
        el("textarea.plug-text", { readOnly: true, value: text, rows: 20 }),
      );
    },
    [
      {
        label: "Copy",
        onClick: () => {
          navigator.clipboard?.writeText(text).then(
            () => toast("Manifest copied", "ok"),
            () => toast("Clipboard unavailable", "err"),
          );
          return false;
        },
      },
      {
        label: "Download",
        onClick: () => {
          download(new Blob([text], { type: "application/json" }), `${p.id}.json`);
          return false;
        },
      },
      { label: "Close", primary: true },
    ],
  );
}

function addSection(refresh) {
  const status = el("div.insp-empty");
  const done = (entries) => {
    applyRegistryChange();
    refresh();
    const names = entries.map((e) => e.name).join(", ");
    status.textContent = "";
    toast(`Installed ${names}`, "ok");
  };
  const fail = (err) => {
    status.replaceChildren(el("pre.fx-dump", null, String(err.message ?? err)));
  };

  const fileInput = el("input", {
    type: "file",
    accept: ".json,application/json",
    style: { display: "none" },
    onchange: async (e) => {
      const f = e.target.files?.[0];
      e.target.value = "";
      if (!f) return;
      try {
        done(await installFromFile(f));
      } catch (err) {
        fail(err);
      }
    },
  });

  const urlField = el("input.search", { type: "url", placeholder: "https://…/plugin.json" });
  const text = el("textarea.plug-text", { rows: 6, placeholder: '{ "id": "me.myEffect", "name": "My Effect", … }' });

  return el(
    "div.plug-add",
    null,
    el("div.plug-head", null, "Add a plugin"),
    el(
      "div.btnrow",
      null,
      el("button.btn", { textContent: "From file…", onclick: () => fileInput.click() }),
      el("button.btn", {
        textContent: "From URL",
        onclick: async () => {
          const url = urlField.value.trim();
          if (!url) return;
          try {
            done(url.endsWith(".js") || url.endsWith(".mjs") ? await loadJs(url) : await installFromUrl(url));
          } catch (err) {
            fail(err);
          }
        },
      }),
      fileInput,
    ),
    urlField,
    el("div.insp-empty", null, "A .json URL installs a manifest. A .js URL runs code, and is confirmed first."),
    text,
    el(
      "div.btnrow",
      null,
      el("button.btn.primary", {
        textContent: "Install pasted JSON",
        onclick: async () => {
          if (!text.value.trim()) return;
          try {
            done(await installManifest(text.value, { replace: true }));
            text.value = "";
          } catch (err) {
            fail(err);
          }
        },
      }),
      el("button.btn", {
        textContent: "Writing plugins \u2197",
        onclick: () => open("./docs/plugins.md", "_blank"),
      }),
    ),
    status,
  );
}

async function loadJs(url) {
  const ok = confirm(
    `Load a JavaScript plugin from:\n\n${url}\n\nUnlike a JSON manifest, this executes code from that URL with full access to this page. Only do it for a source you trust.\n\nJS plugins are not remembered between sessions.`,
  );
  if (!ok) throw new Error("cancelled");
  return installJsModule(url);
}
