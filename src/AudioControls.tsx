import { useEffect, useRef, useState } from 'react';
import { AudioTrack, useLocalParticipant, useRoomContext, useTracks } from '@livekit/components-react';
import { LocalAudioTrack, Track } from 'livekit-client';
import { Mic } from 'lucide-react';
import { incomingLevel, type AudioLevels } from './audio-levels';
import { MicrophoneGain } from './MicrophoneGain';

export function IncomingAudio({ levels, muted }: { levels: AudioLevels; muted: boolean }) {
  const tracks = useTracks([Track.Source.Microphone, Track.Source.ScreenShareAudio, Track.Source.Unknown], { onlySubscribed: true, updateOnlyOn: [] })
    .filter(ref => !ref.participant.isLocal && ref.publication.kind === Track.Kind.Audio);
  return <div hidden>{tracks.map(trackRef => <AudioTrack key={trackRef.publication.trackSid} trackRef={trackRef} volume={incomingLevel(levels, trackRef.participant.identity)} muted={muted} />)}</div>;
}

export function VolumeSlider({ label, value, max = 2, onChange }: { label: string; value: number; max?: number; onChange: (value: number) => void }) {
  return <label className="volume-slider"><span>{label}<output>{Math.round(value * 100)}%</output></span><input type="range" aria-label={label} min="0" max={max * 100} step="5" value={Math.round(value * 100)} aria-valuetext={`${Math.round(value * 100)}%`} onChange={event => onChange(Number(event.target.value) / 100)} /></label>;
}

export function MicrophoneToggle({ volume, notify }: { volume: number; notify: (message: string) => void }) {
  const room = useRoomContext();
  const { localParticipant, microphoneTrack, isMicrophoneEnabled } = useLocalParticipant();
  const [busy, setBusy] = useState(false);
  const latestVolume = useRef(volume); latestVolume.current = volume;
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    const track = microphoneTrack?.track;
    const processor = track instanceof LocalAudioTrack ? track.getProcessor() : undefined;
    if (processor instanceof MicrophoneGain) processor.setLevel(volume);
  }, [volume, microphoneTrack?.track]);
  async function toggle() {
    if (busy) return;
    setBusy(true);
    let created: LocalAudioTrack | undefined;
    try {
      if (isMicrophoneEnabled) await localParticipant.setMicrophoneEnabled(false);
      else {
        await room.startAudio();
        const existing = localParticipant.getTrackPublication(Track.Source.Microphone)?.track;
        if (existing instanceof LocalAudioTrack) {
          const processor = existing.getProcessor();
          if (processor instanceof MicrophoneGain) processor.setLevel(latestVolume.current);
          else await existing.setProcessor(new MicrophoneGain(latestVolume.current));
          if (!mounted.current) return;
          await localParticipant.setMicrophoneEnabled(true);
        } else {
          const tracks = await localParticipant.createTracks({ audio: true });
          created = tracks.find((track): track is LocalAudioTrack => track instanceof LocalAudioTrack);
          if (!created) throw new Error('No microphone');
          await created.setProcessor(new MicrophoneGain(latestVolume.current));
          if (!mounted.current) { created.stop(); return; }
          await localParticipant.publishTrack(created, { source: Track.Source.Microphone });
          if (!mounted.current) { await localParticipant.unpublishTrack(created, true); created = undefined; return; }
          const processor = created.getProcessor();
          if (processor instanceof MicrophoneGain) processor.setLevel(latestVolume.current);
          created = undefined;
        }
      }
    } catch { created?.stop(); if (mounted.current) notify('Не удалось переключить микрофон. Проверьте устройство и разрешение браузера.'); }
    finally { if (mounted.current) setBusy(false); }
  }
  return <button data-lk-enabled={isMicrophoneEnabled} disabled={busy} aria-label="Включить или выключить микрофон" aria-pressed={isMicrophoneEnabled} title="Микрофон" onClick={() => void toggle()}><Mic size={21} /></button>;
}
