/** Interleaved little-endian stereo float PCM, with a bounded latency buffer. */
export class DesktopAudioBuffer {
  private readonly left: Float32Array;
  private readonly right: Float32Array;
  private read = 0;
  private count = 0;
  private remainder = new Uint8Array(0);
  constructor(private readonly capacity = 44100) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new RangeError('Invalid audio buffer size');
    this.left = new Float32Array(capacity); this.right = new Float32Array(capacity);
  }
  push(bytes: Uint8Array) {
    const data = new Uint8Array(this.remainder.length + bytes.length);
    data.set(this.remainder); data.set(bytes, this.remainder.length);
    const length = data.length - data.length % 8, view = new DataView(data.buffer);
    for (let i = 0; i < length; i += 8) {
      if (this.count === this.capacity) { this.read = (this.read + 1) % this.capacity; this.count--; }
      const index = (this.read + this.count) % this.capacity;
      this.left[index] = view.getFloat32(i, true); this.right[index] = view.getFloat32(i + 4, true); this.count++;
    }
    this.remainder = data.slice(length);
  }
  pull(left: Float32Array, right: Float32Array) {
    for (let i = 0; i < left.length; i++) {
      if (this.count) { left[i] = this.left[this.read]; right[i] = this.right[this.read]; this.read = (this.read + 1) % this.capacity; this.count--; }
      else { left[i] = 0; right[i] = 0; }
    }
  }
}
