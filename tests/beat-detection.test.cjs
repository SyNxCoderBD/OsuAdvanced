'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { extract } = require('../beat-detection.js');
const { drum, render, rhythm, nearestError, timingErrors, randomGenerator } = require('./audio-fixtures.cjs');

function assertPulse(result, expected, bpm, tolerance = 0.035) {
  const timing = timingErrors(result.beat, expected, tolerance);
  assert.ok(timing.recall >= 0.92, `missing beats: ${JSON.stringify(timing)}`);
  assert.ok(timing.median <= 0.02, `inaccurate center: ${JSON.stringify(timing)}`);
  assert.ok(timing.p95 <= tolerance, `inaccurate tail: ${JSON.stringify(timing)}`);
  assert.ok(Math.abs(result.bpm - bpm) <= 2, `tempo ${result.bpm}, expected ${bpm}`);
  const matched = result.beat.filter(event => expected.some(t => Math.abs(t - event.t) <= tolerance));
  assert.ok(matched.length / result.beat.length >= 0.92, 'too many off-grid beats');
  for (const layer of ['beat', 'kick', 'snare', 'hat', 'all']) {
    let last = -Infinity;
    for (const event of result[layer]) {
      assert.ok(Number.isFinite(event.t) && event.t >= 0 && event.t > last, 'finite, ordered, nonnegative timestamps');
      assert.ok(Number.isFinite(event.s) && event.s >= 0 && event.s <= 1, 'bounded note strength');
      last = event.t;
    }
  }
}

for (const bpm of [64, 90, 120, 150, 190]) {
  test(`locks to ${bpm} BPM without octave errors or cumulative drift`, async () => {
    const track = rhythm(bpm, { hats: true });
    const result = await extract(render(track.events), 44100);
    assertPulse(result, track.beats, bpm);
  });
}

test('opposite-phase stereo does not cancel the beat', async () => {
  const track = rhythm(100, { hats: true });
  const stereo = render(track.events, { channels: 2, invertRight: true });
  assert.ok(stereo[0].every((sample, i) => sample + stereo[1][i] === 0), 'fixture must cancel in a mono downmix');
  assertPulse(await extract(stereo, 44100), track.beats, 100);
});

test('quiet playback retains the same rhythm as loud playback', async () => {
  const track = rhythm(112, { hats: true });
  const loud = await extract(render(track.events, { amplitude: 0.85 }), 44100);
  const quiet = await extract(render(track.events, { amplitude: 0.004 }), 44100);
  assertPulse(loud, track.beats, 112);
  assertPulse(quiet, track.beats, 112);
});

test('silence and digital black never manufacture notes', async () => {
  for (const input of [new Float32Array(44100 * 8), new Float32Array(44100 * 8).fill(1e-8)]) {
    const result = await extract(input, 44100);
    for (const layer of ['beat', 'kick', 'snare', 'hat', 'all']) assert.deepEqual(result[layer], [], layer);
  }
});

test('a sustained tone is not a stream of drum hits', async () => {
  const pcm = Float32Array.from({ length: 44100 * 8 }, (_, i) => 0.3 * Math.sin(2 * Math.PI * 440 * i / 44100));
  const result = await extract(pcm, 44100);
  for (const layer of ['beat', 'kick', 'snare', 'hat', 'all']) assert.ok(result[layer].length <= 1, `${layer}: ${result[layer].length} false hits`);
});

test('quiet intro and outro stay empty', async () => {
  const track = rhythm(120, { start: 3.35, end: 12.5, duration: 16, hats: true });
  const result = await extract(render(track.events), 44100);
  assertPulse(result, track.beats, 120);
  assert.ok(result.all.every(event => event.t >= 3.25 && event.t <= 12.7), 'onsets in silence');
});

test('a sustained tempo change is tracked rather than extending the old grid', async () => {
  const first = rhythm(90, { start: 0.35, end: 11.5, duration: 24, hats: true });
  const second = rhythm(140, { start: 12.15, end: 23.5, duration: 24, hats: true });
  const result = await extract(render([...first.events, ...second.events], { duration: 24 }), 44100);
  for (const [name, track, bpm] of [['first', first, 90], ['second', second, 140]]) {
    const beats = result.beat.filter(event => name === 'first' ? event.t < 12 : event.t >= 12);
    const timing = timingErrors(beats, track.beats);
    assert.ok(timing.recall >= 0.9, `${name} section lost beats: ${JSON.stringify(timing)}`);
    assert.ok(timing.p95 <= 0.04, `${name} section drifted: ${JSON.stringify(timing)}`);
    assert.ok(beats.filter(event => track.beats.some(t => Math.abs(t - event.t) < 0.04)).length / beats.length >= 0.9, `${name} section has ghost beats`);
  }
});

for (const sampleRate of [22050, 48000]) {
  test(`timing is stable at ${sampleRate} Hz`, async () => {
    const track = rhythm(128, { hats: true });
    assertPulse(await extract(render(track.events, { sampleRate }), sampleRate), track.beats, 128);
  });
}

test('swung offbeat hats do not replace the main pulse', async () => {
  const track = rhythm(105, { hats: true, swing: 0.12 });
  assertPulse(await extract(render(track.events), 44100), track.beats, 105);
});

test('instrument layers separate kicks, snares and hats', async () => {
  const events = [];
  for (let t = 0.4; t < 7.5; t += 0.5) events.push(drum('kick', t));
  for (let t = 0.65; t < 7.5; t += 0.5) events.push(drum('snare', t));
  for (let t = 0.525; t < 7.5; t += 0.25) events.push(drum('hat', t));
  const result = await extract(render(events, { duration: 8 }), 44100);
  for (const [layer, type] of [['kick', 'kick'], ['snare', 'snare'], ['hat', 'hat']]) {
    const expected = events.filter(event => event.type === type);
    const recall = expected.filter(event => nearestError(result[layer], event.t) < 0.035).length / expected.length;
    assert.ok(recall >= 0.9, `${layer} recall ${recall}`);
    const wrong = result[layer].filter(event => events.some(other => other.type !== type && Math.abs(other.t - event.t) < 0.025));
    assert.ok(wrong.length <= 2, `${layer} picked ${wrong.length} events from other instruments`);
  }
});

test('low-level background noise does not become a beatmap', async () => {
  const random = randomGenerator(765);
  const pcm = Float32Array.from({ length: 44100 * 8 }, () => random() * 0.00002);
  const result = await extract(pcm, 44100);
  assert.equal(result.all.length, 0);
});

test('analysis is deterministic, reports progress and preserves the note contract', async () => {
  const pcm = render(rhythm(120).events);
  const progress = [];
  const first = await extract(pcm, 44100, p => progress.push(p));
  const second = await extract(pcm, 44100);
  assert.deepEqual(first, second);
  assert.deepEqual(Object.keys(first).sort(), ['all', 'beat', 'bpm', 'hat', 'kick', 'snare']);
  assert.ok(progress.length >= 2 && progress[0] === 0 && progress.at(-1) === 1);
  assert.ok(progress.every((p, i) => p >= 0 && p <= 1 && (!i || p >= progress[i - 1])));
});

test('invalid and too-short clips are rejected without throwing', async () => {
  assert.equal(await extract(new Float32Array(100), 44100), null);
  assert.equal(await extract(new Float32Array(44100), 0), null);
  assert.equal(await extract([], 44100), null);
  assert.equal(await extract([new Float32Array(44100), new Float32Array(44000)], 44100), null);
});

test('cancelling an analysis stops work', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(extract(new Float32Array(44100), 44100, null, controller.signal), { name: 'AbortError' });
});
