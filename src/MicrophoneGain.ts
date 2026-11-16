import { Track, type AudioProcessorOptions, type TrackProcessor } from 'livekit-client';
import { level } from './audio-levels';
import { activationSettings, loadActivation, type MicrophoneActivationSettings } from './microphone-activation';

const modules = new WeakMap<AudioContext, Promise<void>>();

/** Changes only the outgoing microphone; never connects it to the speakers. */
export class MicrophoneGain implements TrackProcessor<Track.Kind.Audio, AudioProcessorOptions> {
  name = 'krug-microphone-volume';
  processedTrack?: MediaStreamTrack;
  private source?: MediaStreamAudioSourceNode;
  private gain?: GainNode;
  private destination?: MediaStreamAudioDestinationNode;
  private value: number;
  private gate?: AudioWorkletNode;
  private activation = loadActivation();
  activity = { db: -90, open: false };
  constructor(value: number) { this.value = level(value, 2); }
  setLevel(value: number) {
    this.value = level(value, 2);
    if (this.gain) this.gain.gain.setTargetAtTime(this.value, this.gain.context.currentTime, 0.015);
  }
  setActivation(value: MicrophoneActivationSettings) {
    this.activation = activationSettings(value);
    const params = this.gate?.parameters;
    params?.get('enabled')?.setValueAtTime(Number(this.activation.enabled), this.gate!.context.currentTime);
    params?.get('threshold')?.setValueAtTime(this.activation.threshold, this.gate!.context.currentTime);
  }
  async init({ track, audioContext }: AudioProcessorOptions) {
    await this.destroy();
    let module = modules.get(audioContext);
    if (!module) {
      module = audioContext.audioWorklet.addModule('/microphone-gate-worklet.js'); modules.set(audioContext, module);
      module.catch(() => modules.delete(audioContext));
    }
    await module;
    this.source = audioContext.createMediaStreamSource(new MediaStream([track]));
    this.gain = audioContext.createGain();
    this.gain.gain.value = this.value;
    this.destination = audioContext.createMediaStreamDestination();
    this.gate = new AudioWorkletNode(audioContext, 'krug-microphone-gate');
    this.gate.port.onmessage = event => { this.activity = event.data; };
    this.setActivation(this.activation);
    this.source.connect(this.gate); this.gate.connect(this.gain); this.gain.connect(this.destination);
    this.processedTrack = this.destination.stream.getAudioTracks()[0];
  }
  async restart(options: AudioProcessorOptions) { await this.init(options); }
  async destroy() {
    this.source?.disconnect(); this.gate?.disconnect(); this.gate?.port.close(); this.gain?.disconnect(); this.destination?.disconnect();
    this.processedTrack?.stop();
    this.source = undefined; this.gate = undefined; this.gain = undefined; this.destination = undefined; this.processedTrack = undefined;
    this.activity = { db: -90, open: false };
    // The SDK owns the input track and shared AudioContext.
  }
}
