// Usernames are ASCII and unique; boundaries prevent matching addresses and longer names.
export function mentionNames(body: string): string[] {
  return [...new Set([...body.matchAll(/(?:^|[^\p{L}\p{N}_@])@([a-z0-9_]{3,24})(?![a-z0-9_])/giu)].map(match => match[1].toLowerCase()))];
}
