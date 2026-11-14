# OSU Advanced

A dependency-free browser rhythm game. Drop in a song, choose a beat layer, and hit the circles as their rings close.

## Run locally

Serve the folder with any static web server, then open `index.html`:

```sh
python3 -m http.server 8080 --bind 0.0.0.0
```

No build step or runtime package install is required. Opening `index.html` directly also works; analysis falls back to the main thread when workers are unavailable.

## Beat detection

`beat-detection.js` analyzes decoded PCM locally in the browser:

- stereo channels are analyzed before novelty is combined, so opposite-phase channels do not cancel beats;
- log-spectral flux uses adaptive local thresholds and silence gating;
- BPM is estimated from autocorrelation plus pulse coverage, then re-estimated in overlapping windows to follow sustained tempo changes;
- the main pulse is chosen with a tempo-aware onset path instead of a drifting fixed grid;
- kick, snare, hi-hat, and full-mix layers remain available, with cross-band leakage suppression;
- a Web Worker keeps analysis off the UI thread where supported, with an async main-thread fallback.

The analyzer returns the original note contract (`{ t, s }` events and a `bpm` value), so preview, difficulty filtering, scoring, and co-op note sync continue to use the same data shape.

Detection is heuristic: very sparse, heavily syncopated, or tempo-ambiguous music may still need the in-game **Sync nudge** control.

## Circle focus

The next clickable circle is animated with a breathing glow, a rotating dashed crown, and a brighter rim. Upcoming circles are dimmed slightly so the active target is easier to follow. The solid closing ring remains the timing cue, and the hit radius stays stable. The animation is reduced when the operating system requests reduced motion.

## Experimental live mode

Live mode uses the browser's screen-capture permission to listen to audio from another tab, window, or screen:

1. Open **Live mode** and click **Allow screen audio**.
2. Share the music tab with **Also share tab audio**, or share a screen/window with system audio.
3. Play music. After a short listening window, the game locks to the pulse and generates circles live.

Only audio is analyzed locally. The screen image is never drawn, recorded, or uploaded. Capture stops when you leave live mode, stop the session, or close the page. A dedicated worklet collects PCM, a worker re-runs the beat detector on rolling windows, and `live-beats.js` forecasts upcoming pulses so circles can approach before the hit time.

Live mode is under development: it needs a secure context (HTTPS or localhost), works best in desktop Chrome/Edge, and can drift on tempo changes or unclear rhythms. Use the **Live sync** slider on the setup screen or pause menu to compensate for early/late hits.

## Tests

Node 18 or newer is enough; there are no test dependencies:

```sh
npm test
```

The suite renders deterministic synthetic drums and checks tempo locking, timing drift, stereo cancellation, quiet/loud invariance, silence, sustained tones, tempo changes, sample-rate stability, swing, instrument-layer separation, progress reporting, and cancellation. It also tests the live pulse clock: phase locking, overlapping-window deduplication, silence stop, tempo-change recovery, reset, and rolling detector snapshots.
