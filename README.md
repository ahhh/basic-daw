# Basic DAW

A multitrack audio workstation that runs entirely in a browser tab. No build
step, no server, no dependencies — open `index.html` and it works, and it hosts
on GitHub Pages as-is.

Built for personal dev work on real material: import stems, arrange and edit
them, mix with insert effects, bounce a master or a set of stems back out.

![arrangement](docs/screenshot.png)

## Run it

```sh
# any static server; ES modules won't load over file://
python3 -m http.server 8000
open http://localhost:8000
```

## Host it on GitHub Pages

```sh
git init && git add . && git commit -m "basic daw"
git branch -M main
git remote add origin git@github.com:<you>/<repo>.git
git push -u origin main
```

Then **Settings → Pages → Source: Deploy from a branch → main / (root)**.
There is nothing to build; the repo *is* the site.

Everything runs client-side, so nothing you import ever leaves your machine.

## What it does

**Arrangement**
- Import WAV / MP3 / OGG / FLAC / M4A / AIFF by drag-and-drop, anywhere in the window
- Unlimited tracks and clips, canvas-rendered waveforms with a peak pyramid
  (scrolling stays smooth at any zoom)
- Drag to move (multi-select, cross-track), drag edges to trim, drag the top
  corners for fades, `S` to split at the playhead, Alt-drag to copy
- Grid snapping down to 1/16 and triplets, or off; hold Shift to ignore the grid
- Loop region, markers, marquee select, clipboard, unlimited undo

**Clips**
- Gain, fade in/out with equal-power / linear / exponential shapes
- Playback rate and detune (±2400 cents), reverse, mute
- "Match tempo" stretches a clip to a whole number of bars
- Normalize gain from the analysed source peak

**Mixer**
- Per-track fader, pan, mute/solo/arm, live peak meter; stereo master meter
- Insert chains on every track and the master: 4-band EQ (with a live response
  curve), filter, compressor, limiter, noise gate, delay (with ping-pong),
  reverb, chorus, saturator, stereo width, trim
- Bypass, reorder, remove per insert; parameters are smoothed, not stepped

**Transport & recording**
- Sample-accurate look-ahead scheduling, bar-accurate looping, metronome
- Record from any input device onto armed tracks (raw float capture, not Opus)

**Export**
- Bounce the master, the loop region, or the selection to 16/24-bit or 32-bit
  float WAV at 44.1 / 48 / 96 kHz, with an optional tail and peak normalize
- Export stems: one WAV per track, post-insert, pre-master

**Sessions**
- Autosaved to IndexedDB every 20 seconds and restored on reload — audio
  included, kept as the original imported files rather than decoded PCM
- `.dawproj` export (document only) or bundle export (audio inlined) to move a
  session to another machine

Press `?` in the app for the full keyboard map.

## Layout

```
index.html            markup shell — panels, toolbar, hidden file inputs
css/style.css         the whole theme
src/
  main.js             bootstrap, frame loop, splitters
  state.js            project document, selection, undo, grid maths
  assets.js           import → decode → peak pyramid → IndexedDB
  project.js          save/open/export, bounce dialogs
  audio/
    engine.js         AudioContext graph, transport, look-ahead scheduler
    effects.js        insert effects (native nodes only, so bounce == playback)
    render.js         OfflineAudioContext bounce, normalize, analysis
    peaks.js          min/max peak pyramid + waveform drawing
    wav.js            WAV encode, and a decoder for what browsers reject
  storage/db.js       IndexedDB wrapper
  ui/
    timeline.js       arrangement canvas: ruler, clips, every edit gesture
    tracks.js         track headers
    mixer.js          strips, inserts, meters
    inspector.js      clip / track / master / effect editors
    pool.js           sample browser
    transport.js      toolbar and readouts
    controls.js       knob, fader, slider row, meter widgets
    keys.js           keyboard map (and the help dialog that documents it)
```

Two design rules hold the thing together:

1. **The bounce shares the playback code.** `buildChain` and the clip envelope
   maths in `engine.js` are called by both the live graph and the offline
   render, so an export can't drift from what you heard.
2. **Layout is derived, never stored.** The arrangement is
   `x = (t - scrollX) * pxPerSec` over the document; there is no view model to
   keep in sync.

## Known limits

- Rate changes are resampling, not time-stretching: speed and pitch move
  together. There is no phase vocoder.
- Overlapping clips on one track both play; no automatic crossfade.
- No parameter automation lanes yet — mixer moves are static per session.
- Storage is per-origin browser storage. Export a bundle before clearing site
  data, and don't expect a session to follow you between browsers.

## Poking at it

The app exposes itself on `window.daw` (`state`, `engine`, `assets`, `timeline`,
`tracks`, `mixer`-side modules, `project`, `effects`, `render`, `undo`, `redo`)
so you can drive it from the console:

```js
daw.state.project.clips.length
daw.engine.play(4)
daw.timeline.zoomToFit()
daw.state.project.tracks[0].fx.push(daw.effects.newEffect("reverb"))
daw.engine.syncGraph()
await daw.render.renderRange(0, 30)   // bounce a range to an AudioBuffer
```

`test-audio/` holds two generated stems for trying things out.
