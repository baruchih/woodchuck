/** Decode an OSC 52 payload ("<selection>;<base64>") into text. Returns null for
 *  clipboard reads ("?") — programs in a session must not read the viewer's clipboard. */
export function decodeOsc52(data: string): string | null {
  const sep = data.indexOf(';');
  if (sep < 0) return null;
  const b64 = data.slice(sep + 1);
  if (b64 === '?' || b64 === '') return null;
  try {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}
