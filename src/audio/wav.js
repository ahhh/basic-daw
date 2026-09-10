// WAV encoding for bounce/export, plus a fallback decoder for the formats
// browsers refuse (bare 24-bit / 32-bit float WAV in some engines) and a
// float-PCM writer so exported stems keep full headroom.

/**
 * Encode an AudioBuffer (or {channels:[Float32Array], sampleRate}) as WAV.
 * bits: 16 | 24 | 32 (32 = IEEE float).
 */
export function encodeWav(source, bits = 24) {
  const channels = source.numberOfChannels
    ? Array.from({ length: source.numberOfChannels }, (_, i) => source.getChannelData(i))
    : source.channels;
  const sampleRate = source.sampleRate;
  const numCh = channels.length;
  const frames = channels[0].length;
  const float = bits === 32;
  const bytesPer = bits / 8;
  const dataBytes = frames * numCh * bytesPer;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);

  const writeStr = (off, s) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };

  writeStr(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, float ? 3 : 1, true);
  view.setUint16(22, numCh, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * numCh * bytesPer, true);
  view.setUint16(32, numCh * bytesPer, true);
  view.setUint16(34, bits, true);
  writeStr(36, "data");
  view.setUint32(40, dataBytes, true);

  let off = 44;
  if (float) {
    for (let i = 0; i < frames; i++) {
      for (let c = 0; c < numCh; c++) {
        view.setFloat32(off, channels[c][i], true);
        off += 4;
      }
    }
  } else if (bits === 16) {
    for (let i = 0; i < frames; i++) {
      for (let c = 0; c < numCh; c++) {
        const s = Math.max(-1, Math.min(1, channels[c][i]));
        view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
        off += 2;
      }
    }
  } else {
    for (let i = 0; i < frames; i++) {
      for (let c = 0; c < numCh; c++) {
        const s = Math.max(-1, Math.min(1, channels[c][i]));
        const v = Math.round(s < 0 ? s * 0x800000 : s * 0x7fffff);
        view.setUint8(off, v & 0xff);
        view.setUint8(off + 1, (v >> 8) & 0xff);
        view.setUint8(off + 2, (v >> 16) & 0xff);
        off += 3;
      }
    }
  }
  return new Blob([buffer], { type: "audio/wav" });
}

/**
 * Minimal RIFF/WAVE parser used when decodeAudioData rejects a file. Handles
 * PCM 8/16/24/32-bit and IEEE float, mono or multichannel, and returns raw
 * channel data for the caller to wrap in an AudioBuffer.
 */
export function decodeWavFallback(arrayBuffer) {
  const view = new DataView(arrayBuffer);
  const tag = (o) => String.fromCharCode(view.getUint8(o), view.getUint8(o + 1), view.getUint8(o + 2), view.getUint8(o + 3));
  if (tag(0) !== "RIFF" || tag(8) !== "WAVE") throw new Error("not a WAV file");

  let pos = 12;
  let fmt = null;
  let dataOff = -1;
  let dataLen = 0;
  while (pos + 8 <= view.byteLength) {
    const id = tag(pos);
    const size = view.getUint32(pos + 4, true);
    const body = pos + 8;
    if (id === "fmt ") {
      fmt = {
        format: view.getUint16(body, true),
        channels: view.getUint16(body + 2, true),
        sampleRate: view.getUint32(body + 4, true),
        bits: view.getUint16(body + 14, true),
      };
      if (fmt.format === 0xfffe && size >= 40) fmt.format = view.getUint16(body + 24, true);
    } else if (id === "data") {
      dataOff = body;
      dataLen = Math.min(size, view.byteLength - body);
    }
    pos = body + size + (size % 2);
  }
  if (!fmt || dataOff < 0) throw new Error("WAV missing fmt/data chunk");

  const { channels: numCh, sampleRate, bits, format } = fmt;
  const bytesPer = bits / 8;
  const frames = Math.floor(dataLen / (bytesPer * numCh));
  const out = Array.from({ length: numCh }, () => new Float32Array(frames));
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < numCh; c++) {
      const o = dataOff + (i * numCh + c) * bytesPer;
      let v = 0;
      if (format === 3) v = bits === 64 ? view.getFloat64(o, true) : view.getFloat32(o, true);
      else if (bits === 8) v = (view.getUint8(o) - 128) / 128;
      else if (bits === 16) v = view.getInt16(o, true) / 32768;
      else if (bits === 24) {
        const raw = view.getUint8(o) | (view.getUint8(o + 1) << 8) | (view.getUint8(o + 2) << 16);
        v = (raw & 0x800000 ? raw - 0x1000000 : raw) / 8388608;
      } else if (bits === 32) v = view.getInt32(o, true) / 2147483648;
      out[c][i] = v;
    }
  }
  return { channels: out, sampleRate, length: frames };
}

/** Wrap raw channel data in an AudioBuffer belonging to `ctx`. */
export function toAudioBuffer(ctx, { channels, sampleRate, length }) {
  const buf = ctx.createBuffer(channels.length, length, sampleRate);
  for (let c = 0; c < channels.length; c++) buf.copyToChannel(channels[c], c);
  return buf;
}
