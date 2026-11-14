/* OSU Advanced's dependency-free rhythm analyzer.
 * Also runs as a dedicated Web Worker; the browser fallback uses the same code.
 * Times are seconds relative to the original audio, NOT the analysis frames.
 */
(function (factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else if (typeof window === 'undefined' && typeof importScripts === 'function') {
    // Expose the API for companion workers (live mode) as well as installing
    // the default one-shot message handler for ordinary file analysis.
    self.OsuBeatDetection = api;
    self.onmessage = async function (event) {
      try {
        const { channels, sampleRate } = event.data;
        const result = await api.extract(channels, sampleRate,
          progress => self.postMessage({ progress }));
        self.postMessage({ result });
      } catch (error) {
        self.postMessage({ error: error.message || 'Audio analysis failed.' });
      }
    };
  } else {
    globalThis.OsuBeatDetection = api;
  }
})(function () {
  'use strict';
  const BANDS = { kick: [35, 180], snare: [400, 5000], hat: [6000, 16000], all: [35, 16000] };
  const GAPS = { kick: 0.075, snare: 0.075, hat: 0.045, all: 0.055 };
  const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
  const scriptURL = typeof document !== 'undefined' && document.currentScript
    ? document.currentScript.src : '';

  function percentile(values, quantile) {
    if (!values.length) return 0;
    const sorted = Float32Array.from(values).sort();
    return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * quantile))];
  }

  // Exact rolling median/90th percentile. Insertion into a small sorted window
  // avoids letting one loud chorus raise the threshold for an entire quiet verse.
  function localStats(values, fps) {
    const radius = Math.max(2, Math.round(fps * 0.75)), sorted = [];
    const median = new Float32Array(values.length), upper = new Float32Array(values.length);
    function locate(value) {
      let lo = 0, hi = sorted.length;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (sorted[mid] < value) lo = mid + 1; else hi = mid; }
      return lo;
    }
    for (let i = 0; i < Math.min(values.length, radius + 1); i++) sorted.splice(locate(values[i]), 0, values[i]);
    for (let i = 0; i < values.length; i++) {
      if (i) {
        if (i - radius - 1 >= 0) sorted.splice(locate(values[i - radius - 1]), 1);
        if (i + radius < values.length) sorted.splice(locate(values[i + radius]), 0, values[i + radius]);
      }
      median[i] = sorted[(sorted.length - 1) >> 1];
      upper[i] = sorted[Math.floor((sorted.length - 1) * 0.9)];
    }
    return { median, upper };
  }

  // Precomputed twiddles/bit reversal keep repeated FFTs inexpensive on phones.
  function makeFFT(size) {
    const reverse = new Uint16Array(size), cosine = new Float32Array(size / 2), sine = new Float32Array(size / 2);
    for (let i = 0; i < size / 2; i++) {
      cosine[i] = Math.cos(-2 * Math.PI * i / size);
      sine[i] = Math.sin(-2 * Math.PI * i / size);
    }
    const bits = Math.log2(size);
    for (let i = 0; i < size; i++) {
      let value = i, flipped = 0;
      for (let b = 0; b < bits; b++) { flipped = (flipped << 1) | (value & 1); value >>= 1; }
      reverse[i] = flipped;
    }
    return function fft(re, im) {
      for (let i = 0; i < size; i++) {
        const j = reverse[i];
        if (i < j) {
          let tmp = re[i]; re[i] = re[j]; re[j] = tmp;
          tmp = im[i]; im[i] = im[j]; im[j] = tmp;
        }
      }
      for (let length = 2; length <= size; length <<= 1) {
        const half = length >> 1, step = size / length;
        for (let start = 0; start < size; start += length) {
          for (let k = 0; k < half; k++) {
            const x = start + k, y = x + half, tw = k * step;
            const rr = re[y] * cosine[tw] - im[y] * sine[tw];
            const ri = re[y] * sine[tw] + im[y] * cosine[tw];
            re[y] = re[x] - rr; im[y] = im[x] - ri;
            re[x] += rr; im[x] += ri;
          }
        }
      }
    };
  }

  function detectOnsets(values, fps, activity, gap, timeOffset = 0, energy = null) {
    const active = Array.from(values).filter((_, i) => activity[i]);
    const reference = Math.max(percentile(active, 0.95), 1e-7);
    const { median, upper } = localStats(values, fps), out = [];
    const threshold = new Float32Array(values.length);
    const back = Math.max(2, Math.round(fps * 0.025)), ahead = back;
    for (let i = 0; i < values.length; i++) {
      const scale = Math.max(upper[i], reference * 0.12);
      threshold[i] = median[i] + 0.3 * Math.max(0, scale - median[i]) + reference * 0.035;
    }
    function candidate(i) {
      const curvature = values[i - 1] - 2 * values[i] + values[i + 1];
      const fraction = curvature < 0 ? clamp(0.5 * (values[i - 1] - values[i + 1]) / curvature, -0.5, 0.5) : 0;
      const strength = clamp((values[i] - threshold[i]) / (Math.max(upper[i], reference * 0.12) * 1.25), 0.08, 1);
      return { t: (i + fraction) / fps + timeOffset, s: strength };
    }
    for (let i = 1; i < values.length - 1; i++) {
      if (!activity[i] || values[i] <= threshold[i] || (energy && values[i] < energy[i] * 0.015)) continue;
      let peak = true;
      for (let j = Math.max(0, i - back); j <= Math.min(values.length - 1, i + ahead); j++) {
        if (j !== i && (values[j] > values[i] || (values[j] === values[i] && j < i))) { peak = false; break; }
      }
      if (!peak) continue;
      const event = candidate(i), previous = out[out.length - 1];
      if (!previous || event.t - previous.t >= gap) out.push(event);
      else if (event.s > previous.s) out[out.length - 1] = event;
    }
    return out;
  }

  // Comb filtering measures both pulse strength and coverage. Autocorrelation
  // alone often chooses double tempo; a coverage term penalizes skipping beats.
  function estimateTempo(signal, fps, activity, options = {}) {
    const minBpm = options.minBpm || 55, maxBpm = options.maxBpm || 220;
    const priorBpm = options.priorBpm || 120, priorWidth = options.priorWidth || 0.75;
    const reference = Math.max(percentile(signal, 0.95), 1e-7);
    const values = Float32Array.from(signal, x => Math.min(x / reference, 2));
    let total = 0, activeCount = 0;
    for (let i = 0; i < values.length; i++) {
      if (!activity[i]) continue;
      activeCount++;
      // Count peak mass, not frame mass: otherwise zero-padding between hits
      // makes every candidate look like it covers the entire rhythm.
      if (values[i] > 0.15 && values[i] >= (values[i - 1] || 0) && values[i] >= (values[i + 1] || 0)
        && (values[i] > (values[i - 2] || 0) || values[i] > (values[i + 2] || 0))) total += values[i];
    }
    if (activeCount < 8 || total < 1e-5) return { bpm: 120, period: fps / 2, confidence: 0 };
    let best = { bpm: priorBpm, period: fps * 60 / priorBpm, confidence: 0, score: -1 };
    for (let bpm = minBpm; bpm <= maxBpm; bpm += 0.5) {
      const period = fps * 60 / bpm, tolerance = Math.min(fps * 0.045, period * 0.1);
      const phases = Math.max(12, Math.ceil(period * 2));
      let localBest = -1, localCoverage = 0;
      for (let phase = 0; phase < period; phase += period / phases) {
        let sum = 0, covered = 0, count = 0;
        for (let pos = phase; pos < values.length; pos += period) {
          const center = Math.round(pos);
          // Missing pulses count too. Averaging only the frames that happen
          // to be active lets a fast grid cherry-pick three accents and win.
          count++;
          if (!activity[clamp(center, 0, activity.length - 1)]) continue;
          let peak = 0;
          for (let j = Math.max(0, Math.floor(pos - tolerance)); j <= Math.min(values.length - 1, Math.ceil(pos + tolerance)); j++) peak = Math.max(peak, values[j]);
          sum += peak; covered += peak;
        }
        if (count < 3) continue;
        const score = sum / count, coverage = covered / total;
        if (score > localBest) { localBest = score; localCoverage = coverage; }
      }
      if (localBest < 0) continue;
      const lag = Math.round(period);
      let correlation = 0, leftEnergy = 0, rightEnergy = 0;
      for (let i = 0; i + lag < values.length; i++) {
        if (!activity[i] || !activity[i + lag]) continue;
        correlation += values[i] * values[i + lag];
        leftEnergy += values[i] * values[i]; rightEnergy += values[i + lag] * values[i + lag];
      }
      correlation /= Math.sqrt(leftEnergy * rightEnergy) || 1;
      const prior = Math.exp(-0.5 * Math.pow(Math.log2(bpm / priorBpm) / priorWidth, 2));
      const coverage = clamp(localCoverage, 0, 1);
      const score = localBest * coverage * coverage * prior * correlation;
      if (score > best.score) best = { bpm, period, confidence: clamp(correlation * localCoverage, 0, 1), score };
    }
    return best;
  }

  function trackBeats(signal, fps, activity, globalTempo, timeOffset, energy) {
    const onsets = detectOnsets(signal, fps, activity, 0.085, timeOffset, energy);
    if (onsets.length < 2) return onsets;
    // Re-estimate over eight-second windows, then median-smooth adjacent windows.
    // A sustained tempo change is followed instead of dragging the old grid on.
    const window = Math.round(fps * 8), step = Math.max(1, Math.round(fps * 2));
    const estimates = [];
    for (let start = 0; start < signal.length; start += step) {
      const end = Math.min(signal.length, start + window);
      if (end - start < fps * 2 && estimates.length) break;
      const estimate = estimateTempo(signal.subarray(start, end), fps, activity.subarray(start, end), {
        minBpm: Math.max(45, globalTempo.bpm * 0.6), maxBpm: Math.min(240, globalTempo.bpm * 1.6),
        priorBpm: globalTempo.bpm, priorWidth: 0.85
      });
      estimates.push({ t: (start + end) / (2 * fps), period: estimate.period });
    }
    function periodAt(time) {
      if (!estimates.length) return globalTempo.period / fps;
      let index = 0;
      while (index + 1 < estimates.length && estimates[index + 1].t < time) index++;
      const periods = estimates.slice(Math.max(0, index - 1), Math.min(estimates.length, index + 2)).map(x => x.period).sort((a, b) => a - b);
      return periods[periods.length >> 1] / fps;
    }
    const scores = new Float64Array(onsets.length), previous = new Int32Array(onsets.length).fill(-1);
    const used = new Uint8Array(onsets.length);
    for (let i = 0; i < onsets.length; i++) {
      const period = periodAt(onsets[i].t);
      scores[i] = 0.5 + onsets[i].s * 1.5;
      for (let j = i - 1; j >= 0; j--) {
        const interval = onsets[i].t - onsets[j].t;
        if (interval > period * 2.2) break;
        if (interval < period * 0.58) continue;
        const transition = 3 * Math.exp(-0.5 * Math.pow(Math.log(interval / period) / 0.25, 2)) - 1;
        const score = scores[j] + 0.5 + onsets[i].s * 1.5 + transition;
        if (score > scores[i]) { scores[i] = score; previous[i] = j; }
      }
    }
    // Keep the strongest path in each phrase. Backtracing every branch would
    // duplicate shared ancestors and turn rejected subdivisions into notes.
    for (const index of previous) if (index >= 0) used[index] = 1;
    const endpoints = new Map();
    for (let end = 0; end < onsets.length; end++) {
      if (used[end]) continue;
      let root = end;
      while (previous[root] >= 0) root = previous[root];
      if (!endpoints.has(root) || scores[end] > scores[endpoints.get(root)]) endpoints.set(root, end);
    }
    const chains = [];
    for (const end of endpoints.values()) {
      const indices = [];
      for (let i = end; i >= 0; i = previous[i]) indices.push(i);
      if (indices.length >= 3 || onsets.length < 5) {
        indices.reverse();
        chains.push({ indices, score: scores[end], start: onsets[indices[0]].t, end: onsets[indices[indices.length - 1]].t });
      }
    }
    // A subdivision can form its own perfectly regular parallel path. Keep the
    // strongest path while phrases overlap; separate phrases after a break stay.
    chains.sort((a, b) => b.score - a.score);
    const selected = new Uint8Array(onsets.length), kept = [];
    for (const chain of chains) {
      const overlaps = kept.some(other => Math.min(chain.end, other.end) - Math.max(chain.start, other.start)
        > 0.5 * Math.min(chain.end - chain.start, other.end - other.start));
      if (overlaps) continue;
      kept.push(chain);
      for (const index of chain.indices) selected[index] = 1;
    }
    return onsets.filter((_, i) => selected[i]);
  }

  /**
   * Accepts a mono Float32Array or an array of decoded audio channels.
   * Returns the original {beat,kick,snare,hat,all,bpm} contract. Each event is
   * {t: seconds, s: 0..1}; no notes are fabricated in silence.
   */
  async function extract(input, sampleRate, onProgress, signal) {
    const channels = (Array.isArray(input) ? input : [input]).filter(ch => ch && ch.length);
    if (!Number.isFinite(sampleRate) || sampleRate < 4000 || !channels.length) return null;
    const length = channels[0].length;
    if (channels.some(ch => ch.length !== length) || length < sampleRate * 0.8) return null;
    // Native-rate analysis avoids a lossy resampler. Hold the window near 46 ms
    // and the hop near 10 ms at 44.1/48 kHz as well as lower-rate audio files.
    const size = Math.pow(2, Math.round(Math.log2(sampleRate * 1024 / 22050)));
    const hop = Math.max(1, Math.round(sampleRate * 256 / 22050)), fps = sampleRate / hop;
    const frames = Math.floor((length - size) / hop) + 1;
    if (frames < 8) return null;
    // Hann-windowed log flux peaks slightly before the audible attack. Compensate
    // that lead in addition to the usual frame-center timestamp.
    const timeOffset = size * 0.61 / sampleRate;
    const fft = makeFFT(size), window = new Float32Array(size);
    for (let i = 0; i < size; i++) window[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (size - 1));
    const names = Object.keys(BANDS), half = size / 2;
    const ranges = names.map(name => [
      Math.max(1, Math.ceil(BANDS[name][0] * size / sampleRate)),
      Math.min(half - 1, Math.floor(Math.min(BANDS[name][1], sampleRate * 0.48) * size / sampleRate))
    ]);
    const raw = names.map(() => new Float32Array(frames));
    const energy = new Float32Array(frames), activity = new Uint8Array(frames);
    const re = new Float32Array(size), im = new Float32Array(size);
    const previous = channels.map(() => new Float32Array(half)), flux = new Float32Array(half);
    for (let frame = 0; frame < frames; frame++) {
      if (signal && signal.aborted) throw new DOMException('Analysis cancelled', 'AbortError');
      const offset = frame * hop;
      flux.fill(0);
      let power = 0;
      // Analyze channels separately BEFORE combining novelty. Opposite-phase
      // stereo channels must not cancel each other out as they did in a mono mix.
      for (let channel = 0; channel < channels.length; channel++) {
        const data = channels[channel];
        let channelPower = 0;
        for (let i = 0; i < size; i++) { const sample = data[offset + i]; re[i] = sample * window[i]; im[i] = 0; channelPower += sample * sample; }
        power = Math.max(power, channelPower / size);
        fft(re, im);
        for (let bin = 1; bin < half; bin++) {
          const value = Math.log1p(200 * Math.hypot(re[bin], im[bin]) / size);
          flux[bin] = Math.max(flux[bin], value - previous[channel][bin], 0);
          previous[channel][bin] = value;
        }
      }
      energy[frame] = Math.sqrt(power);
      for (let band = 0; band < names.length; band++) {
        const [lo, hi] = ranges[band];
        let sum = 0;
        for (let bin = lo; bin <= hi; bin++) sum += flux[bin];
        raw[band][frame] = frame ? sum / Math.sqrt(Math.max(1, hi - lo + 1)) : 0;
      }
      if (frame % 48 === 0) {
        if (onProgress) onProgress(frame / frames);
        await new Promise(resolve => setTimeout(resolve, 0));
      }
    }
    const peakEnergy = Math.max(percentile(energy, 0.98), 1e-8);
    const noiseGate = Math.max(1e-4, peakEnergy * 0.003, percentile(energy, 0.1) * 0.25);
    for (let i = 0; i < frames; i++) activity[i] = energy[i] > noiseGate ? 1 : 0;
    let scales = raw.map(values => Math.max(percentile(values, 0.95), 1e-7));
    // Broadband attacks leak into neighboring FFT bands. Subtract that leakage
    // gently, preserving low-end thumps that happen together with a snare/hat.
    if (ranges[2][1] >= ranges[2][0]) {
      for (let i = 0; i < frames; i++) {
        const kick = raw[0][i], snare = raw[1][i], hat = raw[2][i];
        const k = kick / scales[0], s = snare / scales[1], h = hat / scales[2];
        raw[0][i] = Math.max(0, kick - 0.6 * hat - 0.2 * snare);
        raw[1][i] = Math.max(0, s - 0.8 * k - 0.55 * h) * scales[1];
        raw[2][i] = Math.max(0, h - 0.7 * s) * scales[2];
      }
      scales = raw.map(values => Math.max(percentile(values, 0.95), 1e-7));
    }
    const result = {};
    names.forEach((name, band) => { result[name] = detectOnsets(raw[band], fps, activity, GAPS[name], timeOffset, energy); });
    const fused = new Float32Array(frames), normalized = raw.map((values, b) => Float32Array.from(values, x => Math.min(x / scales[b], 3)));
    for (let i = 1; i < frames; i++) {
      const rise = Math.max(0, Math.log((energy[i] + peakEnergy * 0.001) / (energy[i - 1] + peakEnergy * 0.001)));
      fused[i] = normalized[0][i] + normalized[1][i] + 0.1 * normalized[2][i] + 0.2 * Math.min(rise, 3);
      if (raw[3][i] < energy[i] * 0.015) fused[i] = 0;
    }
    const tempoEstimate = estimateTempo(fused, fps, activity);
    result.beat = trackBeats(fused, fps, activity, tempoEstimate, timeOffset, energy);
    result.bpm = Math.round(tempoEstimate.bpm * 10) / 10;
    if (onProgress) onProgress(1);
    return result;
  }

  return Object.freeze({ extract, scriptURL });
});
