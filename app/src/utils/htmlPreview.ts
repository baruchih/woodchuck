/** Whether a URL in an HTML file points at another file next to it */
export function isRelativeRef(ref: string): boolean {
  const r = ref.trim();
  if (!r || r.startsWith('#') || r.startsWith('/')) return false;
  // Any scheme (http:, https:, data:, blob:, mailto:, javascript:...)
  return !/^[a-z][a-z0-9+.-]*:/i.test(r);
}

/** Resolve a relative reference against the folder of `fromFile`, dropping ?query and #hash */
export function resolveRelative(fromFile: string, ref: string): string {
  const clean = ref.trim().split(/[?#]/)[0];
  const parts = fromFile.split('/').slice(0, -1);
  for (const seg of clean.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length > 0 && parts[parts.length - 1] !== '..' && parts[parts.length - 1] !== '') parts.pop();
      else if (parts.length === 0) parts.push('..');
    } else {
      parts.push(seg);
    }
  }
  return parts.join('/');
}

// Attributes that load a file the page needs to render
const RESOURCE_ATTRS: [string, string][] = [
  ['img', 'src'],
  ['link[rel~="stylesheet" i]', 'href'],
  ['link[rel~="icon" i]', 'href'],
  ['source', 'src'],
  ['video', 'src'],
  ['video', 'poster'],
  ['audio', 'src'],
  ['input[type="image" i]', 'src'],
];

/**
 * Prepare an HTML file for a sandboxed preview: point its relative images,
 * stylesheets and media at the session's file stream endpoint, so they load
 * even though the preview document has no URL of its own.
 */
export function buildPreviewHtml(html: string, filePath: string, sessionId: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const streamUrl = (path: string) =>
    `/api/sessions/${encodeURIComponent(sessionId)}/stream?path=${encodeURIComponent(path)}`;
  for (const [selector, attr] of RESOURCE_ATTRS) {
    doc.querySelectorAll(selector).forEach((el) => {
      const value = el.getAttribute(attr);
      if (value && isRelativeRef(value)) el.setAttribute(attr, streamUrl(resolveRelative(filePath, value)));
    });
  }
  return '<!DOCTYPE html>\n' + doc.documentElement.outerHTML;
}
