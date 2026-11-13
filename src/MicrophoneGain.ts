import { Track, type AudioProcessorOptions, type TrackProcessor } from 'livekit-client';
import { level } from './audio-levels';

/** Changes only the outgoing microphone; never connects it to the speakers. */
export class MicrophoneGain implements TrackProcessor<Track.Kind.Audio, AudioProcessorOptions> {
  name = 'krug-microphone-volume';
  processedTrack?: MediaStreamTrack;
  private source?: MediaStreamAudioSourceNode;
  private gain?: GainNode;
  private destination?: MediaStreamAudioDestinationNode;
  private value: number;
  constructor(value: number) { this.value = level(value, 2); }
  setLevel(value: number) {
    this.value = level(value, 2);
    if (this.gain) this.gain.gain.setTargetAtTime(this.value, this.gain.context.currentTime, 0.015);
  }
  async init({ track, audioContext }: AudioProcessorOptions) {
    await this.destroy();
    this.source = audioContext.createMediaStreamSource(new MediaStream([track]));
    this.gain = audioContext.createGain();
    this.gain.gain.value = this.value;
    this.destination = audioContext.createMediaStreamDestination();
    this.source.connect(this.gain); this.gain.connect(this.destination);
    this.processedTrack = this.destination.stream.getAudioTracks()[0];
  }
  async restart(options: AudioProcessorOptions) { await this.init(options); }
  async destroy() {
    this.source?.disconnect(); this.gain?.disconnect(); this.destination?.disconnect();
    this.processedTrack?.stop();
    this.source = undefined; this.gain = undefined; this.destination = undefined; this.processedTrack = undefined;
    // The SDK owns the input track and shared AudioContext.
  }
}
