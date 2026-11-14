/* Rolling-window beat analysis for live mode. Reuses the file analyzer so
 * streaming and uploaded songs share the same onset/tempo behavior.
 */
'use strict';
importScripts('./beat-detection.js');

self.onmessage = async function (event) {
  const message = event.data || {};
  if (message.type !== 'analyze') return;
  const { channels, sampleRate, endTime, id } = message;
  try {
    const result = await self.OsuBeatDetection.extract(channels, sampleRate);
    self.postMessage({
      type: 'snapshot', id, endTime,
      duration: channels[0].length / sampleRate,
      bpm: result ? result.bpm : 0,
      beats: result ? result.beat : []
    });
  } catch (error) {
    self.postMessage({ type: 'error', id, error: error.message || 'Live analysis failed.' });
  }
};
