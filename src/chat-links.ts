export function isTrustedService(url: URL, currentOrigin: string): boolean {
  return url.origin === currentOrigin || (url.protocol === 'https:' && (url.hostname === 'nioservices.website' || url.hostname.endsWith('.nioservices.website')));
}

export function splitLinks(text: string): { text: string; href?: string }[] {
  const parts: { text: string; href?: string }[] = [];
  const pattern = /https?:\/\/[^\s<>"']+|www\.[^\s<>"']+/giu;
  let offset = 0;
  for (const match of text.matchAll(pattern)) {
    let candidate = match[0];
    while (/[.,!?;:)]$/.test(candidate)) candidate = candidate.slice(0, -1);
    if (!candidate) continue;
    try {
      const url = new URL(candidate.startsWith('www.') ? `https://${candidate}` : candidate);
      if (!['http:', 'https:'].includes(url.protocol)) continue;
      if (match.index! > offset) parts.push({ text: text.slice(offset, match.index) });
      parts.push({ text: candidate, href: url.href });
      offset = match.index! + candidate.length;
    } catch { /* Keep invalid input as text. */ }
  }
  if (offset < text.length) parts.push({ text: text.slice(offset) });
  return parts;
}
