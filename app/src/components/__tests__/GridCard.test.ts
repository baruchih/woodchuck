import { describe, it, expect } from 'vitest';
import { getPreviewLines } from '../GridCard';

describe('getPreviewLines', () => {
  it('returns empty string for empty input', () => {
    expect(getPreviewLines('', 10)).toBe('');
  });

  it('returns all lines when under max', () => {
    const output = 'line1\nline2\nline3';
    expect(getPreviewLines(output, 10)).toBe('line1\nline2\nline3');
  });

  it('returns last N lines when over max', () => {
    const lines = Array.from({ length: 20 }, (_, i) => `line${i + 1}`);
    const output = lines.join('\n');
    const result = getPreviewLines(output, 5);
    expect(result).toBe('line16\nline17\nline18\nline19\nline20');
  });

  it('strips trailing empty lines', () => {
    const output = 'line1\nline2\n\n\n';
    expect(getPreviewLines(output, 10)).toBe('line1\nline2');
  });

  it('strips trailing whitespace-only lines', () => {
    const output = 'line1\nline2\n   \n  \n';
    expect(getPreviewLines(output, 10)).toBe('line1\nline2');
  });

  it('handles single line input', () => {
    expect(getPreviewLines('hello', 10)).toBe('hello');
  });

  it('handles maxLines of 1', () => {
    const output = 'line1\nline2\nline3';
    expect(getPreviewLines(output, 1)).toBe('line3');
  });

  it('preserves ANSI codes in output', () => {
    const output = '\x1b[31mred text\x1b[0m\nnormal';
    const result = getPreviewLines(output, 10);
    expect(result).toContain('\x1b[31m');
  });
});
