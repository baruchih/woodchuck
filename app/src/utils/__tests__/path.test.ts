import { describe, it, expect } from 'vitest';
import { getFolderName, truncatePath } from '../path';

describe('getFolderName', () => {
  it('returns last segment of a path', () => {
    expect(getFolderName('/home/user/projects/my-app')).toBe('my-app');
  });

  it('handles single segment', () => {
    expect(getFolderName('my-app')).toBe('my-app');
  });

  it('handles trailing slash by returning original path', () => {
    // split('/') on "/foo/" gives ["", "foo", ""], last is ""
    expect(getFolderName('/foo/')).toBe('/foo/');
  });

  it('handles root path', () => {
    expect(getFolderName('/')).toBe('/');
  });

  it('handles deeply nested path', () => {
    expect(getFolderName('/a/b/c/d/e/project')).toBe('project');
  });
});

describe('truncatePath', () => {
  it('returns short paths unchanged', () => {
    expect(truncatePath('/home/user/app')).toBe('/home/user/app');
  });

  it('returns path unchanged if exactly at max length', () => {
    const path = 'a'.repeat(40);
    expect(truncatePath(path, 40)).toBe(path);
  });

  it('truncates long paths to last two segments', () => {
    const longPath = '/home/user/very/deep/nested/projects/my-app';
    expect(truncatePath(longPath, 20)).toBe('.../projects/my-app');
  });

  it('keeps paths with 2 or fewer segments unchanged even if long', () => {
    const path = '/very-long-folder-name-that-exceeds-limit';
    expect(truncatePath(path, 10)).toBe(path);
  });

  it('uses default max length of 40', () => {
    const shortPath = '/home/user/app';
    expect(truncatePath(shortPath)).toBe(shortPath);
  });
});
