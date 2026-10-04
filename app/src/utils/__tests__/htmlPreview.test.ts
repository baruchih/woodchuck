import { describe, it, expect } from 'vitest';
import { isRelativeRef, resolveRelative } from '../htmlPreview';

describe('isRelativeRef', () => {
  it('accepts paths next to the file', () => {
    expect(isRelativeRef('style.css')).toBe(true);
    expect(isRelativeRef('./img/a.png')).toBe(true);
    expect(isRelativeRef('../shared/x.css')).toBe(true);
  });

  it('rejects absolute URLs, anchors and data', () => {
    for (const ref of ['', '#top', '/abs.css', '//cdn.example.com/x.js', 'https://x.io/a.png',
      'data:image/png;base64,AA', 'blob:abc', 'mailto:a@b.c', 'javascript:alert(1)']) {
      expect(isRelativeRef(ref)).toBe(false);
    }
  });
});

describe('resolveRelative', () => {
  it('resolves against the file folder', () => {
    expect(resolveRelative('docs/report/index.html', 'style.css')).toBe('docs/report/style.css');
    expect(resolveRelative('docs/report/index.html', './img/a.png')).toBe('docs/report/img/a.png');
    expect(resolveRelative('docs/report/index.html', '../shared/x.css')).toBe('docs/shared/x.css');
  });

  it('works for files at the root and absolute paths', () => {
    expect(resolveRelative('index.html', 'a.png')).toBe('a.png');
    expect(resolveRelative('/Users/me/proj/index.html', 'css/a.css')).toBe('/Users/me/proj/css/a.css');
  });

  it('drops query strings and fragments', () => {
    expect(resolveRelative('a/index.html', 'b.css?v=3#x')).toBe('a/b.css');
  });

  it('keeps leading .. that escape the start (the server rejects paths outside the session)', () => {
    expect(resolveRelative('index.html', '../x.png')).toBe('../x.png');
  });
});
