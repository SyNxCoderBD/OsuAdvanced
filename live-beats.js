/* Streaming pulse prediction for experimental live mode.
 * The audio detector finds recent beats; this clock locks to their phase and
 * forecasts the next few beats so circles can approach before the hit time.
 * It never records audio and never invents a pulse after the music goes quiet.
 */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.OsuLiveBeats = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
  const median = values => {
    if (!values.length) return 0;
    const sorted = values.slice().sort((a, b) => a - b);
    return sorted[sorted.length >> 1];
  };

  function createClock(options = {}) {
    const minAhead = options.minAhead || 0.9;
    const horizon = options.horizon || 2.6;
    const memory = options.memory || 14;
    let observations = [], period = 0, anchor = 0, lastBeat = -Infinity;
    let lastEnd = -Infinity, ready = false, bpm = 0, updates = 0;

    function reset() {
      observations = []; period = 0; anchor = 0; lastBeat = -Infinity;
      lastEnd = -Infinity; ready = false; bpm = 0; updates = 0;
    }

    // snapshot: { endTime, duration, bpm, beats: [{t,s}] } with beats relative
    // to the start of the analyzed audio window. endTime is on the game clock.
    function update(snapshot) {
      const endTime = Number(snapshot.endTime), duration = Number(snapshot.duration);
      if (!Number.isFinite(endTime) || !Number.isFinite(duration) || duration <= 0) return state();
      const start = endTime - duration;
      const incoming = (snapshot.beats || [])
        .map(event => ({ t: start + Number(event.t), s: Number(event.s) || 0.5 }))
        .filter(event => Number.isFinite(event.t) && event.t >= start - 0.05 && event.t <= endTime + 0.08)
        .sort((a, b) => a.t - b.t);
      // Overlapping windows repeat many of the same hits. Merge by absolute
      // time rather than appending, or the observation list loses its order.
      const merged = [];
      let i = 0, j = 0;
      while (i < observations.length || j < incoming.length) {
        const event = j >= incoming.length || (i < observations.length && observations[i].t <= incoming[j].t)
          ? observations[i++] : incoming[j++];
        const previous = merged[merged.length - 1];
        if (previous && Math.abs(previous.t - event.t) < 0.09) {
          if (event.s >= previous.s) merged[merged.length - 1] = event;
        } else merged.push(event);
      }
      observations = merged.filter(event => event.t >= endTime - memory).slice(-48);
      lastEnd = endTime;
      if (observations.length < 3) { ready = false; return state(); }

      const reported = clamp(Number(snapshot.bpm) || 120, 45, 240);
      const base = 60 / reported, intervals = [];
      for (let i = Math.max(1, observations.length - 12); i < observations.length; i++) {
        const interval = observations[i].t - observations[i - 1].t;
        if (interval >= base * 0.65 && interval <= base * 1.45) intervals.push(interval);
      }
      const measured = median(intervals) || base;
      if (period && measured / period >= 0.85 && measured / period <= 1.18) period += (measured - period) * 0.25;
      else period = measured;
      period = clamp(period, 60 / 240, 60 / 45);

      const latest = observations[observations.length - 1].t;
      if (anchor) {
        const aligned = latest + Math.round((anchor - latest) / period) * period;
        const delta = aligned - anchor;
        // Small phase corrections keep the approach rings steady; a genuine
        // restart/tempo change is allowed to snap to the new downbeat.
        anchor = Math.abs(delta) < period * 0.22 ? anchor + delta * 0.3 : latest;
      } else anchor = latest;
      lastBeat = latest; bpm = 60 / period; ready = true; updates++;
      return state();
    }

    function recent(now) {
      return ready && Number.isFinite(lastBeat) && now - lastBeat <= Math.max(1.6, period * 2.5);
    }

    function predict(now, customHorizon = horizon, customMinAhead = minAhead) {
      if (!recent(now) || !period) return [];
      const first = anchor + Math.ceil((now + customMinAhead - anchor) / period) * period;
      const out = [];
      for (let t = first, index = Math.round((first - anchor) / period); t <= now + customHorizon + 1e-6; t += period, index++) {
        if (t < now + customMinAhead - 1e-6) continue;
        out.push({ t, s: ((index % 4) + 4) % 4 === 0 ? 0.85 : 0.55 });
      }
      return out;
    }

    function state() {
      return { ready, bpm, period, anchor, lastBeat, lastEnd, updates, observed: observations.length };
    }

    return Object.freeze({ update, predict, recent, reset, state });
  }

  return Object.freeze({ createClock });
});
