// Share files through the device's share sheet (Web Share API), so a file from a
// session can go straight to Drive, Files, or a chat app.

const MIME_BY_EXT: Record<string, string> = {
  pdf: 'application/pdf',
  zip: 'application/zip',
  json: 'application/json',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  heic: 'image/heic',
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/ogg',
  flac: 'audio/flac',
  html: 'text/html',
  htm: 'text/html',
  css: 'text/css',
  csv: 'text/csv',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

/** MIME type for a file name. Unknown types count as text (code, markdown, logs). */
export function mimeForName(name: string, isText: boolean): string {
  const ext = name.toLowerCase().split('.').pop() || '';
  return MIME_BY_EXT[ext] ?? (isText ? 'text/plain' : 'application/octet-stream');
}

/** Whether this browser can share files at all (Safari/Chrome on iOS, Chrome on macOS, Android). */
export function canShareFiles(): boolean {
  if (typeof navigator === 'undefined' || typeof navigator.canShare !== 'function') return false;
  try {
    return navigator.canShare({ files: [new File(['x'], 'x.txt', { type: 'text/plain' })] });
  } catch {
    return false;
  }
}

/** Fetch a file from the server as a File object ready for sharing. */
export async function fetchShareableFile(url: string, name: string, isText: boolean): Promise<File> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const blob = await res.blob();
  return new File([blob], name, { type: mimeForName(name, isText) });
}

// Chromium (Chrome, Edge, Brave on desktop and Android) only shares these
// extensions and rejects anything else with a NotAllowedError, even though
// canShare() says yes. Safari has no such list.
const CHROMIUM_SHAREABLE_EXTENSIONS = new Set([
  'bmp', 'css', 'csv', 'ehtml', 'flac', 'gif', 'htm', 'html', 'ico', 'jfif', 'jpeg', 'jpg',
  'm4a', 'm4v', 'mp3', 'mp4', 'mpeg', 'mpg', 'oga', 'ogg', 'ogm', 'ogv', 'opus', 'pdf', 'pjp',
  'pjpeg', 'png', 'shtm', 'shtml', 'svg', 'svgz', 'text', 'tif', 'tiff', 'txt', 'wav', 'weba',
  'webm', 'webp', 'xbm',
]);

interface UADataNavigator {
  userAgentData?: { brands?: { brand: string }[] };
}

function isChromium(): boolean {
  return !!(navigator as unknown as UADataNavigator).userAgentData?.brands?.some((b) => b.brand === 'Chromium');
}

/**
 * Adapt a file to what this browser will actually share. In Chromium, text files
 * with other extensions (.md, .json, code) go out as "name.ext.txt"; other
 * types can't be shared there at all, and null is returned.
 */
export function adaptForBrowser(file: File, isText: boolean): File | null {
  if (!isChromium()) return file;
  const ext = file.name.toLowerCase().includes('.') ? file.name.toLowerCase().split('.').pop()! : '';
  if (CHROMIUM_SHAREABLE_EXTENSIONS.has(ext)) return file;
  if (isText) return new File([file], `${file.name}.txt`, { type: 'text/plain' });
  return null;
}
