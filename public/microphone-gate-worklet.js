// Runs on the audio thread: tab throttling must not freeze the microphone gate.
class MicrophoneGate extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [{ name: 'enabled', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'threshold', defaultValue: -45, minValue: -70, maxValue: -10, automationRate: 'k-rate' }];
  }
  constructor() { super(); this.gain = 0; this.hold = 0; this.report = 0; this.open = false; }
  process(inputs, outputs, parameters) {
    const input = inputs[0], output = outputs[0];
    if (!input?.length || !output?.length) return true;
    const frames = input[0].length;
    let squares = 0;
    for (const channel of input) for (const sample of channel) squares += sample * sample;
    const db = Math.max(-90, 20 * Math.log10(Math.max(1e-9, Math.sqrt(squares / (frames * input.length)))));
    const enabled = parameters.enabled[0] >= .5;
    const threshold = parameters.threshold[0] - (this.open ? 3 : 0);
    if (!enabled || db >= threshold) { this.hold = sampleRate * .2; this.open = true; }
    else { this.hold -= frames; if (this.hold <= 0) this.open = false; }
    const target = this.open ? 1 : 0;
    const coefficient = Math.exp(-1 / (sampleRate * (target ? .005 : .04)));
    for (let i = 0; i < frames; i++) {
      this.gain = !enabled ? 1 : target + coefficient * (this.gain - target);
      if (this.gain < .00001) this.gain = 0;
      for (let channel = 0; channel < output.length; channel++) output[channel][i] = (input[channel]?.[i] ?? input[0][i]) * this.gain;
    }
    this.report += frames;
    if (this.report >= sampleRate / 15) { this.report = 0; this.port.postMessage({ db, open: this.open }); }
    return true;
  }
}
registerProcessor('krug-microphone-gate', MicrophoneGate);
