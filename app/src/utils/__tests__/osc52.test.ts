import { describe, it, expect } from 'vitest';
import { decodeOsc52 } from '../osc52';

const b64 = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));

describe('decodeOsc52', () => {
  it('decodes a clipboard write', () => {
    expect(decodeOsc52(`c;${b64('92. In ac felis')}`)).toBe('92. In ac felis');
  });

  it('decodes UTF-8 text', () => {
    expect(decodeOsc52(`c;${b64('héllo → ✓')}`)).toBe('héllo → ✓');
  });

  it('accepts an empty selection parameter', () => {
    expect(decodeOsc52(`;${b64('x')}`)).toBe('x');
  });

  it('refuses clipboard reads', () => {
    expect(decodeOsc52('c;?')).toBeNull();
  });

  it('ignores malformed payloads', () => {
    expect(decodeOsc52('no-separator')).toBeNull();
    expect(decodeOsc52('c;')).toBeNull();
    expect(decodeOsc52('c;***not base64***')).toBeNull();
  });
});
