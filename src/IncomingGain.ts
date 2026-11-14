import type { RemoteAudioTrack } from 'livekit-client';

/** One local gain stage per remote track, including an exact zero independent of SDK fades. */
export class IncomingGain {
  private readonly node: GainNode;
  constructor(private readonly track: RemoteAudioTrack, private readonly context: AudioContext, value: number) {
    this.node = context.createGain();
    this.node.gain.value = value;
    track.setVolume(1);
    track.setWebAudioPlugins([this.node]);
  }
  setLevel(value: number) {
    const now = this.context.currentTime;
    this.node.gain.cancelScheduledValues(now);
    if (value === 0) this.node.gain.setValueAtTime(0, now);
    else this.node.gain.setTargetAtTime(value, now, 0.015);
  }
  close() {
    // Removing the plugin must not briefly restore full volume before the element detaches.
    this.track.setVolume(0);
    this.track.setWebAudioPlugins([]);
    this.node.disconnect();
  }
}
