// Top bar: transport buttons, tempo/grid fields, position readout, master meter.

import { $, clamp, fmtBBT, fmtTime, popupMenu, toast } from "../util.js";
import { bus, changed, pushUndo, state } from "../state.js";
import { engine } from "../audio/engine.js";
import { assetFromBuffer } from "../assets.js";
import { dropAssetAt, scrollToPlayhead } from "./timeline.js";
import { exportMenu, projectMenu } from "../project.js";

let follow = true;

export function initTransport() {
  const btn = (id, fn) => $(id).addEventListener("click", fn);

  btn("#btn-play", togglePlay);
  btn("#btn-stop", stop);
  btn("#btn-goto-start", () => {
    engine.seek(0);
    scrollToPlayhead(true);
    changed("view", false);
  });
  btn("#btn-record", toggleRecord);
  btn("#btn-loop", toggleLoop);
  btn("#btn-metro", () => {
    engine.metronome = !engine.metronome;
    syncButtons();
  });
  btn("#btn-follow", () => {
    follow = !follow;
    syncButtons();
  });
  btn("#btn-export", (e) => popupMenu(e.clientX, e.clientY - 4, exportMenu()));
  btn("#btn-project", (e) => popupMenu(e.clientX, e.clientY - 4, projectMenu()));

  const bpm = $("#in-bpm");
  bpm.addEventListener("change", () => {
    pushUndo("tempo");
    state.project.bpm = clamp(Number(bpm.value) || 120, 20, 300);
    bpm.value = String(state.project.bpm);
    changed("project");
  });
  const num = $("#in-sig-num");
  const den = $("#in-sig-den");
  num.addEventListener("change", () => {
    pushUndo("time signature");
    state.project.sigNum = clamp(Number(num.value) || 4, 1, 16);
    changed("project");
  });
  den.addEventListener("change", () => {
    pushUndo("time signature");
    state.project.sigDen = Number(den.value) || 4;
    changed("project");
  });
  $("#in-snap").addEventListener("change", (e) => {
    state.project.snap = e.target.value;
    changed("view", false);
  });

  bus.on("project", syncFields);
  bus.on("loop", syncButtons);
  bus.on("history", syncButtons);
  syncFields();
  syncButtons();
}

export function togglePlay() {
  engine.ensure();
  if (engine.playing) engine.pause();
  else engine.play(state.playhead);
  syncButtons();
  changed("view", false);
}

export function stop() {
  if (engine.recording) finishRecording();
  engine.stop(); // parks the playhead itself
  syncButtons();
  changed("view", false);
}

export function toggleLoop() {
  const loop = state.project.loop;
  if (loop.end <= loop.start) {
    // No region yet: make one bar at the playhead so the button always does something.
    const bar = (60 / state.project.bpm) * state.project.sigNum;
    loop.start = state.playhead;
    loop.end = state.playhead + bar * 4;
  }
  loop.enabled = !loop.enabled;
  changed("loop");
  engine.invalidate();
}

async function toggleRecord() {
  if (engine.recording) return void finishRecording();
  const armed = state.project.tracks.filter((t) => t.armed);
  if (!armed.length) return toast("Arm a track first (● on the track header)", "err");
  try {
    engine.ensure();
    await engine.startRecording(false);
    if (!engine.playing) engine.play(state.playhead);
    syncButtons();
    toast("Recording…", "ok");
  } catch (err) {
    toast(`Microphone unavailable: ${err.message}`, "err", 5000);
  }
}

async function finishRecording() {
  const result = engine.stopRecording();
  syncButtons();
  if (!result) return;
  const track = state.project.tracks.find((t) => t.armed) ?? state.project.tracks[0];
  const asset = await assetFromBuffer(`Take ${new Date().toLocaleTimeString()}`, result.buffer);
  dropAssetAt(asset.id, track.id, result.startPos);
  toast(`Recorded ${result.buffer.duration.toFixed(1)}s`, "ok");
}

export function setFollow(v) {
  follow = v;
}
export const getFollow = () => follow;

function syncFields() {
  $("#in-bpm").value = String(state.project.bpm);
  $("#in-sig-num").value = String(state.project.sigNum);
  $("#in-sig-den").value = String(state.project.sigDen);
  $("#in-snap").value = state.project.snap;
  syncButtons();
}

export function syncButtons() {
  $("#btn-play").classList.toggle("on", engine.playing);
  $("#btn-play").textContent = engine.playing ? "⏸" : "▶";
  $("#btn-record").classList.toggle("on", engine.recording);
  $("#btn-loop").classList.toggle("on", state.project.loop.enabled);
  $("#btn-metro").classList.toggle("on", engine.metronome);
  $("#btn-follow").classList.toggle("on", follow);
}

/* ── per-frame readouts ───────────────────────────────────────────────── */

let peakHold = 0;
let peakHoldUntil = 0;

export function updateReadouts(levels) {
  const p = state.project;
  const pos = engine.playing ? engine.position : state.playhead;
  $("#pos-bbt").textContent = fmtBBT(pos, p.bpm, p.sigNum, p.sigDen);
  $("#pos-time").textContent = fmtTime(pos);

  const m = levels.get("master") ?? { peak: 0, peakR: 0 };
  const pct = (v) => `${Math.round(clamp(1 + (v > 0 ? 20 * Math.log10(v) : -60) / 60, 0, 1) * 100)}%`;
  $("#mm-l").style.width = pct(m.peak);
  $("#mm-r").style.width = pct(m.peakR);

  const now = performance.now();
  const peak = Math.max(m.peak, m.peakR);
  if (peak > peakHold || now > peakHoldUntil) {
    peakHold = peak;
    peakHoldUntil = now + 1600;
    const el = $("#mm-peak");
    const db = peak > 0 ? 20 * Math.log10(peak) : -Infinity;
    el.textContent = isFinite(db) ? db.toFixed(1) : "-∞";
    el.classList.toggle("clip", db > -0.1);
  }

  if (follow && engine.playing) scrollToPlayhead();
}
