export function fingerprintText(text: string): string {
  let hash = 0x811c9dc5;
  const normalized = text.replace(/\r\n?/gu, '\n').trim();
  for (let index = 0; index < normalized.length; index += 1) {
    hash ^= normalized.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}
