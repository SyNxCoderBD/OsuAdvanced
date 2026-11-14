'use strict';

// Small, deterministic PCM fixtures. No copyrighted music or downloads needed.
function randomGenerator(seed = 1234567) {
  return () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296 * 2 - 1; };
}

function drum(type, time, gain = 1) {
  return { type, t: time, gain };
}

function render(events, { sampleRate = 44100, duration = 16, channels = 1, amplitude = 0.8, invertRight = false, pad = 0 } = {}) {
  const pcm = Array.from({ length: channels }, () => new Float32Array(Math.round(sampleRate * duration)));
  const random = randomGenerator();
  for (const event of events) {
    const start = Math.round(event.t * sampleRate), length = Math.round(sampleRate * (event.type === 'kick' ? 0.24 : event.type === 'snare' ? 0.16 : 0.07));
    let phase = 0, snareNoise = 0;
    for (let i = 0; i < length && start + i < pcm[0].length; i++) {
      const t = i / sampleRate, noise = random();
      let sample;
      if (event.type === 'kick') {
        phase += 2 * Math.PI * (48 + 115 * Math.exp(-t * 35)) / sampleRate;
        sample = Math.sin(phase) * Math.exp(-t * 20) * 0.85;
      } else if (event.type === 'snare') {
        snareNoise += 0.4 * (noise - snareNoise);
        sample = (snareNoise * 0.7 + Math.sin(2 * Math.PI * 185 * t) * 0.25) * Math.exp(-t * 32);
      } else {
        // High-only metallic partials keep the hat fixture out of the snare band.
        sample = (Math.sin(2 * Math.PI * 7300 * t) + Math.sin(2 * Math.PI * 9100 * t) + Math.sin(2 * Math.PI * 11300 * t)) * Math.exp(-t * 90) * 0.12;
      }
      sample *= Math.min(1, t / 0.0006) * event.gain * amplitude;
      for (let channel = 0; channel < channels; channel++) pcm[channel][start + i] += sample * (invertRight && channel === 1 ? -1 : 1);
    }
  }
  if (pad) {
    for (let channel = 0; channel < channels; channel++) {
      for (let i = 0; i < pcm[channel].length; i++) {
        const t = i / sampleRate;
        pcm[channel][i] += pad * (Math.sin(2 * Math.PI * 110 * t) + 0.4 * Math.sin(2 * Math.PI * 220 * t));
      }
    }
  }
  return channels === 1 ? pcm[0] : pcm;
}

function rhythm(bpm, { start = 0.35, duration = 16, hats = false, swing = 0, end = duration - 0.5 } = {}) {
  const events = [], beats = [], period = 60 / bpm;
  for (let index = 0; start + index * period < end; index++) {
    const t = start + index * period;
    beats.push(t);
    events.push(drum(index % 2 ? 'snare' : 'kick', t, index % 4 === 0 ? 1 : 0.8));
    if (hats) {
      events.push(drum('hat', t, 0.55));
      if (t + period * (0.5 + swing) < end) events.push(drum('hat', t + period * (0.5 + swing), 0.4));
    }
  }
  return { events, beats };
}

function nearestError(actual, expected) {
  if (!actual.length) return Infinity;
  return Math.min(...actual.map(event => Math.abs(event.t - expected)));
}

function timingErrors(actual, expected, tolerance = 0.05) {
  const errors = expected.map(t => nearestError(actual, t));
  const sorted = errors.slice().sort((a, b) => a - b);
  return { median: sorted[Math.floor(sorted.length / 2)], p95: sorted[Math.floor((sorted.length - 1) * 0.95)], max: sorted[sorted.length - 1], recall: errors.filter(e => e <= tolerance).length / errors.length };
}

function wavFixture(pcm, sampleRate = 22050) {
  const samples = Array.isArray(pcm) ? pcm[0] : pcm;
  const buffer = Buffer.alloc(44 + samples.length * 2);
  buffer.write('RIFF', 0); buffer.writeUInt32LE(buffer.length - 8, 4); buffer.write('WAVEfmt ', 8);
  buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24); buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32); buffer.writeUInt16LE(16, 34); buffer.write('data', 36);
  buffer.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i++) buffer.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767), 44 + i * 2);
  return buffer;
}

module.exports = { drum, render, rhythm, nearestError, timingErrors, randomGenerator, wavFixture };
