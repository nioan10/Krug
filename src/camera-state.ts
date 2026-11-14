// A publication may remain in LiveKit after its camera is muted or detached.
export function hasVisibleCamera(publication: { isMuted: boolean; track?: unknown } | undefined, muted: boolean): boolean {
  return Boolean(publication && !muted && !publication.isMuted && publication.track);
}
