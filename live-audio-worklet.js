/* Copies short PCM blocks from the permission-granted capture stream.
 * No audio is played back, recorded to disk, or sent over the network.
 */
class OsuLiveCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.block = 2048;
    this.offset = 0;
    this.pending = null;
    this.running = true;
    this.port.onmessage = event => {
      if (event.data === 'stop') this.running = false;
    };
  }

  process(inputs) {
    const input = inputs[0];
    if (!this.running) return false;
    if (!input || !input.length || !input[0].length) return true;
    const channels = Math.min(2, input.length);
    if (!this.pending || this.pending.length !== channels) {
      this.pending = Array.from({ length: channels }, () => new Float32Array(this.block));
      this.offset = 0;
    }
    let copied = 0;
    while (copied < input[0].length) {
      const count = Math.min(this.block - this.offset, input[0].length - copied);
      for (let channel = 0; channel < channels; channel++) {
        this.pending[channel].set(input[channel].subarray(copied, copied + count), this.offset);
      }
      this.offset += count; copied += count;
      if (this.offset === this.block) {
        const channelsOut = this.pending;
        this.port.postMessage({ channels: channelsOut, samples: this.block }, channelsOut.map(buffer => buffer.buffer));
        this.pending = Array.from({ length: channels }, () => new Float32Array(this.block));
        this.offset = 0;
      }
    }
    // Outputs stay silent: the node is connected only to keep processing alive.
    return true;
  }
}

registerProcessor('osu-live-capture', OsuLiveCapture);
