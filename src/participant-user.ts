export function participantUserId(participant: { identity: string; metadata?: string }) {
  try { const id = JSON.parse(participant.metadata || '{}').userId; return typeof id === 'string' && id.length <= 64 ? id : participant.identity; }
  catch { return participant.identity; }
}
