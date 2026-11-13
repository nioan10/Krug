// Integration smoke test against an already running, self-owned LiveKit instance.
// Uses generated PCM and video frames, never the microphone/camera/screen.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { AccessToken, RoomServiceClient } from 'livekit-server-sdk';
import { Room, RoomEvent, AudioSource, AudioStream, AudioFrame, LocalAudioTrack, VideoSource, VideoFrame, VideoStream, VideoBufferType, LocalVideoTrack, TrackPublishOptions, TrackSource, dispose } from '@livekit/rtc-node';
const url = process.env.LIVEKIT_URL;
const key = process.env.LIVEKIT_API_KEY;
const secret = process.env.LIVEKIT_API_SECRET;
if (!url || !key || !secret) throw new Error('Run with node --env-file=.env scripts/test-media.mjs');
const roomName = `smoke-${randomUUID()}`;
const sender = new Room(); const receiver = new Room();
const deadline = setTimeout(() => { console.error('Media smoke test timed out.'); process.exit(1); }, 25_000);
let audioSource; let videoSource; let videoTimer; let audioReader; let videoReader;
async function token(identity) { const t = new AccessToken(key, secret, { identity, ttl: '2m' }); t.addGrant({ roomJoin: true, room: roomName, canPublish: true, canSubscribe: true, canPublishData: false, canUpdateOwnMetadata: false }); return t.toJwt(); }
function subscription(source) { return new Promise(resolve => receiver.on(RoomEvent.TrackSubscribed, (track, publication) => { if (publication.source === source) resolve(track); })); }
try {
  const audioSubscribed = subscription(TrackSource.SOURCE_MICROPHONE);
  const videoSubscribed = subscription(TrackSource.SOURCE_SCREENSHARE);
  await receiver.connect(url, await token('smoke-receiver'), { autoSubscribe: true });
  await sender.connect(url, await token('smoke-sender'), { autoSubscribe: true });
  console.log('Both WebRTC peers connected.');
  audioSource = new AudioSource(48000, 1);
  const audioTrack = LocalAudioTrack.createAudioTrack('synthetic-audio', audioSource);
  const audioOptions = new TrackPublishOptions({ source: TrackSource.SOURCE_MICROPHONE });
  await sender.localParticipant.publishTrack(audioTrack, audioOptions);
  audioReader = new AudioStream(await audioSubscribed).getReader();
  const audioReceived = audioReader.read();
  for (let frameIndex = 0; frameIndex < 50; frameIndex++) {
    const data = new Int16Array(480);
    for (let i = 0; i < data.length; i++) data[i] = Math.round(3000 * Math.sin(2 * Math.PI * 440 * (frameIndex * 480 + i) / 48000));
    await audioSource.captureFrame(new AudioFrame(data, 48000, 1, 480));
  }
  const audio = await audioReceived;
  assert.ok(audio.value?.data.length > 0, 'No audio samples received');
  console.log('Synthetic audio received.');
  videoSource = new VideoSource(320, 180);
  const videoTrack = LocalVideoTrack.createVideoTrack('synthetic-screen', videoSource);
  await sender.localParticipant.publishTrack(videoTrack, new TrackPublishOptions({ source: TrackSource.SOURCE_SCREENSHARE }));
  const pixels = new Uint8Array(320 * 180 * 4);
  for (let i = 0; i < pixels.length; i += 4) { pixels[i] = 185; pixels[i + 1] = 237; pixels[i + 2] = 140; pixels[i + 3] = 255; }
  videoTimer = setInterval(() => videoSource.captureFrame(new VideoFrame(pixels, 320, 180, VideoBufferType.RGBA)), 100);
  videoReader = new VideoStream(await videoSubscribed).getReader();
  const video = await videoReader.read();
  assert.equal(video.value?.frame.width, 320); assert.equal(video.value?.frame.height, 180);
  console.log('Synthetic screen-share video received (320x180). PASS.');
} finally {
  clearTimeout(deadline); clearInterval(videoTimer);
  await audioReader?.cancel(); await videoReader?.cancel();
  await sender.disconnect(); await receiver.disconnect();
  await audioSource?.close(); await videoSource?.close();
  await new RoomServiceClient(url.replace(/^ws/, 'http'), key, secret).deleteRoom(roomName).catch(() => {});
  await dispose();
}
