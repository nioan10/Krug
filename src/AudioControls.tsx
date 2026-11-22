import { participantUserId } from './participant-user';
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { AudioTrack, useLocalParticipant, useRoomContext, useTracks, type TrackReference } from '@livekit/components-react';
import { LocalAudioTrack, RemoteAudioTrack, Track } from 'livekit-client';
import { Mic } from 'lucide-react';
import { incomingLevel, level, type AudioLevels } from './audio-levels';
import { MicrophoneGain } from './MicrophoneGain';
import { IncomingGain } from './IncomingGain';
import { microphoneErrorMessage, withMicrophoneRecovery, type MicrophoneStage } from './microphone-control';

function ControlledAudio({ trackRef, volume, muted }: { trackRef: TrackReference; volume: number; muted: boolean }) {
  const room = useRoomContext();
  const context = typeof room.options.webAudioMix === 'object' ? room.options.webAudioMix.audioContext : undefined;
  const track = trackRef.publication.track;
  const gain = useRef<IncomingGain | null>(null);
  const effective = muted ? 0 : volume;
  const latest = useRef(effective); latest.current = effective;
  useLayoutEffect(() => {
    if (!context || !(track instanceof RemoteAudioTrack)) return;
    const controller = new IncomingGain(track, context, latest.current);
    gain.current = controller;
    return () => { gain.current = null; controller.close(); };
  }, [context, track]);
  useLayoutEffect(() => { gain.current?.setLevel(effective); }, [effective]);
  return <AudioTrack trackRef={trackRef} volume={context ? undefined : Math.min(1, effective)} muted={effective === 0} />;
}

export function IncomingAudio({ levels, muted }: { levels: AudioLevels; muted: boolean }) {
  const tracks = useTracks([Track.Source.Microphone, Track.Source.ScreenShareAudio, Track.Source.Unknown], { onlySubscribed: true, updateOnlyOn: [] })
    .filter(ref => !ref.participant.isLocal && ref.publication.kind === Track.Kind.Audio);
  return <div hidden>{tracks.map(trackRef => <ControlledAudio key={trackRef.publication.trackSid} trackRef={trackRef} volume={incomingLevel(levels, participantUserId(trackRef.participant), trackRef.source === Track.Source.ScreenShareAudio ? trackRef.participant.identity : undefined)} muted={muted} />)}</div>;
}

export function VolumeSlider({ label, value, max = 2, onChange }: { label: string; value: number; max?: number; onChange: (value: number) => void }) {
  const id = useId();
  const percent = Math.round(value * 1000) / 10;
  const [draft, setDraft] = useState(percent.toFixed(1));
  const editing = useRef(false);
  useEffect(() => { if (!editing.current) setDraft(percent.toFixed(1)); }, [percent]);
  function change(percentValue: number) { if (Number.isFinite(percentValue)) onChange(level(Math.round(percentValue * 10) / 1000, max)); }
  return <div className="volume-slider"><div className="volume-heading"><label htmlFor={id}>{label}</label><div className="volume-value"><input type="number" aria-label={`${label}, процентов`} inputMode="decimal" min="0" max={max * 100} step="0.1" value={draft} onFocus={() => { editing.current = true; }} onBlur={() => { editing.current = false; setDraft(percent.toFixed(1)); }} onChange={event => { setDraft(event.target.value); change(event.target.valueAsNumber); }} /><span>%</span></div></div><input id={id} type="range" aria-label={label} min="0" max={max * 100} step="0.1" value={percent} aria-valuetext={`${percent.toFixed(1)}%`} onChange={event => change(Number(event.target.value))} /></div>;
}

export function MicrophoneToggle({ volume, notify }: { volume: number; notify: (message: string) => void }) {
  const room = useRoomContext();
  const { localParticipant, microphoneTrack, isMicrophoneEnabled } = useLocalParticipant();
  useEffect(() => { window.KrugAndroidNative?.setMicrophoneActive(isMicrophoneEnabled); return () => window.KrugAndroidNative?.setMicrophoneActive(false); }, [isMicrophoneEnabled]);
  const [busy, setBusy] = useState(false);
  const toggling = useRef(false);
  const latestVolume = useRef(volume); latestVolume.current = volume;
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    const track = microphoneTrack?.track;
    const processor = track instanceof LocalAudioTrack ? track.getProcessor() : undefined;
    if (processor instanceof MicrophoneGain) processor.setLevel(volume);
  }, [volume, microphoneTrack?.track]);
  async function toggle() {
    if (toggling.current) return;
    toggling.current = true;
    setBusy(true);
    let created: LocalAudioTrack | undefined;
    let stage: MicrophoneStage = isMicrophoneEnabled ? 'mute' : 'capture';
    const recovered = () => notify('Выбранный микрофон недоступен. Включён микрофон по умолчанию.');
    try {
      if (isMicrophoneEnabled) await localParticipant.setMicrophoneEnabled(false);
      else {
        // Playback may reject (or wait for another gesture) independently of microphone access.
        // LiveKit's StartAudio button handles playback recovery; it must not block speaking.
        void room.startAudio().catch(() => {});
        const existing = localParticipant.getTrackPublication(Track.Source.Microphone)?.track;
        if (existing instanceof LocalAudioTrack) {
          const processor = existing.getProcessor();
          if (processor instanceof MicrophoneGain) processor.setLevel(latestVolume.current);
          else { stage = 'processor'; await existing.setProcessor(new MicrophoneGain(latestVolume.current)); }
          if (!mounted.current) return;
          stage = 'unmute';
          await withMicrophoneRecovery(room, () => localParticipant.setMicrophoneEnabled(true), () => mounted.current, recovered);
        } else {
          const tracks = await withMicrophoneRecovery(room, () => localParticipant.createTracks({ audio: true }), () => mounted.current, recovered);
          created = tracks.find((track): track is LocalAudioTrack => track instanceof LocalAudioTrack);
          if (!created) throw new Error('No microphone');
          if (!mounted.current) { created.stop(); return; }
          stage = 'processor';
          await created.setProcessor(new MicrophoneGain(latestVolume.current));
          if (!mounted.current) { created.stop(); return; }
          stage = 'publish';
          await localParticipant.publishTrack(created, { source: Track.Source.Microphone });
          if (!mounted.current) { await localParticipant.unpublishTrack(created, true); created = undefined; return; }
          const processor = created.getProcessor();
          if (processor instanceof MicrophoneGain) processor.setLevel(latestVolume.current);
          created = undefined;
        }
      }
    } catch (error) {
      created?.stop();
      console.warn('Microphone operation failed', stage, error);
      if (mounted.current) notify(microphoneErrorMessage(error, stage));
    }
    finally { toggling.current = false; if (mounted.current) setBusy(false); }
  }
  return <button data-lk-enabled={isMicrophoneEnabled} disabled={busy} aria-label="Включить или выключить микрофон" aria-pressed={isMicrophoneEnabled} title="Микрофон" onClick={() => void toggle()}><Mic size={21} /></button>;
}
