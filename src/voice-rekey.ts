import type { ExternalE2EEKeyProvider, LocalTrack, Room, TrackPublishOptions } from 'livekit-client';

/** Move to a freshly encrypted room while retaining the actual capture tracks (including screen audio). */
export class VoiceRekey {
  private retained = new Map<LocalTrack, TrackPublishOptions | undefined>();
  private stopped = false;
  constructor(private room: Room, private provider: ExternalE2EEKeyProvider) {}
  stop() { this.stopped = true; for (const track of this.retained.keys()) track.stop(); this.retained.clear(); }
  async switch(key: ArrayBuffer, url: string, token: string, signal: AbortSignal) {
    const check = () => { signal.throwIfAborted(); if (this.stopped) throw new DOMException('Call ended', 'AbortError'); };
    check();
    for (const pub of this.room.localParticipant.trackPublications.values()) if (pub.track) this.retained.set(pub.track, { ...pub.options, source: pub.source });
    const abort = () => { void this.room.disconnect(false); };
    signal.addEventListener('abort', abort, { once: true });
    try {
      // Stop publishing with the old key before changing it. Never downgrade encryption.
      await Promise.all([...this.room.localParticipant.trackPublications.values()].map(pub => pub.track ? this.room.localParticipant.unpublishTrack(pub.track, false) : undefined));
      check(); await this.room.disconnect(false); check();
      await this.provider.setKey(key); check();
      await this.room.setE2EEEnabled(true); check();
      try { await this.room.connect(url, token); } catch { check(); throw new TypeError('Медиасервер временно недоступен при смене ключа.'); }
      check();
      for (const [track, options] of this.retained) {
        if (track.mediaStreamTrack.readyState !== 'ended') { await this.room.localParticipant.publishTrack(track, options); check(); }
      }
      this.retained.clear();
    } finally { signal.removeEventListener('abort', abort); }
  }
}
