'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createClock } = require('../live-beats.js');
const { extract } = require('../beat-detection.js');
const { render, rhythm, nearestError } = require('./audio-fixtures.cjs');

// Snapshots use the same relative beat times as the live analysis worker.
function windowSnapshot(beats, endTime, duration, bpm) {
  const start = endTime - duration;
  return { endTime, duration, bpm, beats: beats.filter(t => t >= start && t < endTime).map(t => ({ t: t - start, s: 0.7 })) };
}

function assertPredictions(clock, now, expected, tolerance = 0.05) {
  const predicted = clock.predict(now, 2.6, 0.9);
  assert.ok(predicted.length >= 2, 'expected upcoming circles');
  for (const event of predicted) {
    assert.ok(event.t >= now + 0.89, 'circle must have approach time');
    assert.ok(nearestError(expected.map(t => ({ t })), event.t) <= tolerance, `predicted off-beat circle at ${event.t}`);
  }
  const future = expected.filter(t => t >= now + 0.9 && t <= now + 2.6);
  const recall = future.filter(t => predicted.some(event => Math.abs(event.t - t) <= tolerance)).length / Math.max(1, future.length);
  assert.ok(recall >= 0.8, `missed upcoming beats: ${recall}`);
}

test('live clock locks phase and forecasts upcoming beats', () => {
  const track = rhythm(120, { duration: 24, hats: true });
  const clock = createClock();
  for (let endTime = 6; endTime <= 14; endTime += 1) clock.update(windowSnapshot(track.beats, endTime, 8, 120));
  const state = clock.state();
  assert.ok(state.ready);
  assert.ok(Math.abs(state.bpm - 120) <= 2, `live BPM ${state.bpm}`);
  assertPredictions(clock, 14, track.beats);
});

test('overlapping windows do not duplicate the pulse', () => {
  const track = rhythm(100, { duration: 20 });
  const clock = createClock();
  for (let endTime = 8; endTime <= 14; endTime += 0.75) clock.update(windowSnapshot(track.beats, endTime, 8, 100));
  const inMemory = track.beats.filter(t => t >= 14 - 14 && t < 14).length;
  assert.ok(clock.state().observed <= inMemory + 1, 'deduplicated observations');
  assertPredictions(clock, 14, track.beats);
});

test('live predictions stop after the music goes quiet', () => {
  const track = rhythm(120, { duration: 12, end: 8 });
  const clock = createClock();
  for (let endTime = 6; endTime <= 8; endTime += 1) clock.update(windowSnapshot(track.beats, endTime, 8, 120));
  assert.ok(clock.predict(8, 2.6, 0.9).length >= 1);
  clock.update(windowSnapshot([], 10, 8, 120));
  clock.update(windowSnapshot([], 12, 8, 120));
  assert.deepEqual(clock.predict(12, 2.6, 0.9), []);
  assert.equal(clock.recent(12), false);
});

test('live clock follows a sustained tempo change', () => {
  const first = rhythm(90, { start: 0.35, end: 11.5, duration: 28 });
  const second = rhythm(140, { start: 12.15, end: 27, duration: 28 });
  const beats = [...first.beats, ...second.beats];
  const clock = createClock();
  for (let endTime = 6; endTime <= 20; endTime += 1) {
    const bpm = endTime < 12 ? 90 : endTime > 16 ? 140 : 115;
    clock.update(windowSnapshot(beats, endTime, 8, bpm));
  }
  assert.ok(Math.abs(clock.state().bpm - 140) <= 8, `tempo change not tracked: ${clock.state().bpm}`);
  assertPredictions(clock, 20, second.beats, 0.07);
});

test('reset clears the live lock', () => {
  const track = rhythm(120, { duration: 16 });
  const clock = createClock();
  clock.update(windowSnapshot(track.beats, 10, 8, 120));
  assert.equal(clock.state().ready, true);
  clock.reset();
  assert.equal(clock.state().ready, false);
  assert.deepEqual(clock.predict(10), []);
});

test('rolling real detector snapshots drive live predictions', async () => {
  const sampleRate = 22050, track = rhythm(120, { duration: 20, hats: true });
  const pcm = render(track.events, { sampleRate, duration: 20 });
  const clock = createClock();
  for (let endTime = 8; endTime <= 14; endTime += 2) {
    const start = endTime - 8;
    const result = await extract(pcm.slice(start * sampleRate, endTime * sampleRate), sampleRate);
    clock.update({ endTime, duration: 8, bpm: result.bpm, beats: result.beat });
  }
  assert.ok(clock.state().ready, 'detector did not lock live');
  assert.ok(Math.abs(clock.state().bpm - 120) <= 3, `rolling BPM ${clock.state().bpm}`);
  assertPredictions(clock, 14, track.beats, 0.06);
});
