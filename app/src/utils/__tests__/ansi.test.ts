import { describe, it, expect } from 'vitest';
import { ansiToHtml } from '../ansi';

describe('ansiToHtml', () => {
  it('returns plain text unchanged', () => {
    const result = ansiToHtml('hello world');
    expect(result).toBe('hello world');
  });

  it('converts ANSI red to HTML span', () => {
    const result = ansiToHtml('\x1b[31mError\x1b[0m');
    expect(result).toContain('Error');
    expect(result).toContain('color');
  });

  it('converts ANSI green to HTML span', () => {
    const result = ansiToHtml('\x1b[32mSuccess\x1b[0m');
    expect(result).toContain('Success');
    expect(result).toContain('color');
  });

  it('converts bold ANSI codes', () => {
    const result = ansiToHtml('\x1b[1mBold text\x1b[0m');
    expect(result).toContain('Bold text');
    expect(result).toContain('<b>');
  });

  it('handles multiple colors in one string', () => {
    const result = ansiToHtml('\x1b[31mred\x1b[0m and \x1b[32mgreen\x1b[0m');
    expect(result).toContain('red');
    expect(result).toContain('green');
  });

  it('escapes HTML entities for XSS protection', () => {
    const result = ansiToHtml('<script>alert("xss")</script>');
    expect(result).not.toContain('<script>');
    expect(result).toContain('&lt;script&gt;');
  });

  it('escapes HTML entities within ANSI-colored text', () => {
    const result = ansiToHtml('\x1b[31m<b>not bold</b>\x1b[0m');
    expect(result).not.toContain('<b>');
    expect(result).toContain('&lt;b&gt;');
  });

  it('handles empty string', () => {
    expect(ansiToHtml('')).toBe('');
  });

  it('handles strings with only ANSI codes (no visible text)', () => {
    const result = ansiToHtml('\x1b[0m');
    // Should not throw, result may be empty or whitespace
    expect(typeof result).toBe('string');
  });
});
