// @ts-nocheck — Uses Node fs/path which aren't in the browser tsconfig
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(__dirname, '../../styles/index.css'), 'utf-8');
const indexHtml = readFileSync(join(__dirname, '../../../index.html'), 'utf-8');
const layout = readFileSync(join(__dirname, '../Layout.tsx'), 'utf-8');

/**
 * Verify the viewport meta tag, CSS rules, and Layout component
 * that prevent the terminal from jumping when the mobile keyboard opens.
 */

describe('Mobile keyboard viewport', () => {
  it('viewport meta tag includes interactive-widget=resizes-content', () => {
    expect(indexHtml).toContain('interactive-widget=resizes-content');
  });

  it('html,body has overflow:hidden to prevent document scroll', () => {
    expect(css).toContain('overflow: hidden');
  });

  it('html,body has overscroll-behavior: none', () => {
    expect(css).toContain('overscroll-behavior: none');
  });
});

describe('Layout component', () => {
  it('uses h-dvh for dynamic viewport height', () => {
    expect(layout).toContain('h-dvh');
  });

  it('uses overflow-hidden on the root container', () => {
    expect(layout).toContain('overflow-hidden');
  });

  it('does not use visualViewport JS (handled by interactive-widget)', () => {
    expect(layout).not.toContain('visualViewport');
  });
});
