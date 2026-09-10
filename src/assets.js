// The sample pool: decode imported files, build peak pyramids, keep the
// original blob in IndexedDB so the project survives a reload.

import { assets, bus } from "./state.js";
import { uid, fmtBytes, toast } from "./util.js";
import { engine } from "./audio/engine.js";
import { buildPeaks } from "./audio/peaks.js";
import { decodeWavFallback, toAudioBuffer, encodeWav } from "./audio/wav.js";
import { putAssetBlob, getAssetBlob, deleteAssetBlob } from "./storage/db.js";

const AUDIO_RE = /\.(wav|wave|mp3|ogg|oga|opus|flac|m4a|mp4|aac|aif|aiff|webm)$/i;

export const isAudioFile = (file) => file.type.startsWith("audio/") || AUDIO_RE.test(file.name);

/** Decode one File/Blob into an AudioBuffer, falling back to our own WAV parser. */
export async function decodeFile(file) {
  const ctx = engine.ensure();
  const bytes = await file.arrayBuffer();
  try {
    return await ctx.decodeAudioData(bytes.slice(0));
  } catch (err) {
    try {
      return toAudioBuffer(ctx, decodeWavFallback(bytes));
    } catch {
      throw new Error(`could not decode "${file.name}" (${err?.message ?? "unsupported format"})`);
    }
  }
}

/** Register a decoded buffer in the pool (and persist its source blob). */
export async function addAsset({ id = uid("ast"), name, buffer, blob, persist = true }) {
  const peaks = await buildPeaks(buffer);
  const asset = {
    id,
    name,
    buffer,
    peaks,
    duration: buffer.duration,
    sampleRate: buffer.sampleRate,
    channels: buffer.numberOfChannels,
    size: blob?.size ?? buffer.length * buffer.numberOfChannels * 4,
    peak: peaks.peak,
    rms: peaks.rms,
    missing: false,
  };
  assets.set(id, asset);
  if (persist && blob) {
    await putAssetBlob({ id, name, type: blob.type || "audio/wav", size: blob.size, blob, createdAt: Date.now() });
  }
  bus.emit("assets");
  return asset;
}

/** Import files chosen by the user. Returns the created assets, in order. */
export async function importFiles(files, onProgress) {
  const list = [...files].filter(isAudioFile);
  if (!list.length) {
    toast("No audio files in that drop", "err");
    return [];
  }
  const out = [];
  for (let i = 0; i < list.length; i++) {
    const file = list[i];
    onProgress?.(i / list.length, file.name);
    try {
      const buffer = await decodeFile(file);
      const asset = await addAsset({ name: file.name.replace(/\.[^.]+$/, ""), buffer, blob: file });
      out.push(asset);
    } catch (err) {
      toast(err.message, "err", 5000);
      console.error(err);
    }
  }
  onProgress?.(1, "");
  if (out.length) {
    const total = out.reduce((n, a) => n + a.size, 0);
    toast(`Imported ${out.length} file${out.length > 1 ? "s" : ""} · ${fmtBytes(total)}`, "ok");
  }
  return out;
}

/** Re-decode the blobs a loaded project needs. Missing ones become placeholders. */
export async function rehydrateAssets(assetMetas, onProgress) {
  let done = 0;
  for (const meta of assetMetas ?? []) {
    if (assets.has(meta.id)) continue;
    const rec = await getAssetBlob(meta.id);
    if (!rec?.blob) {
      assets.set(meta.id, { ...meta, buffer: null, peaks: null, missing: true });
      continue;
    }
    try {
      const buffer = await decodeFile(rec.blob);
      await addAsset({ id: meta.id, name: meta.name ?? rec.name, buffer, blob: rec.blob, persist: false });
    } catch {
      assets.set(meta.id, { ...meta, buffer: null, peaks: null, missing: true });
    }
    onProgress?.(++done / assetMetas.length, meta.name);
  }
  bus.emit("assets");
}

export async function removeAsset(id) {
  assets.delete(id);
  await deleteAssetBlob(id).catch(() => {});
  bus.emit("assets");
}

/** Serializable pool description stored inside the project document. */
export function serializeAssets() {
  // The whole pool is listed, not just what clips reference: an imported stem
  // you have not dropped on the timeline yet should still be there next session.
  return [...assets.values()].map((a) => ({
    id: a.id,
    name: a.name,
    duration: a.duration,
    sampleRate: a.sampleRate,
    channels: a.channels,
    size: a.size,
  }));
}

/** Bake a buffer into a fresh pool asset (used by reverse/normalize/render-in-place). */
export async function assetFromBuffer(name, buffer) {
  const blob = encodeWav(buffer, 24);
  return addAsset({ name, buffer, blob });
}
