/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck — Uses Node fs/path which aren't in the browser tsconfig
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(__dirname, '../../styles/index.css'), 'utf-8');
const layout = readFileSync(join(__dirname, '../Layout.tsx'), 'utf-8');

/**
 * Verify CSS rules and Layout component patterns that prevent the
 * terminal from jumping when the mobile keyboard opens.
 */

describe('Mobile keyboard viewport CSS', () => {
  it('has overflow:hidden on html,body to prevent document scroll', () => {
    expect(css).toContain('overflow: hidden');
  });

  it('has position:fixed on html,body to lock the body', () => {
    expect(css).toContain('position: fixed');
  });

  it('has width/height 100% so body fills viewport', () => {
    expect(css).toContain('width: 100%');
    expect(css).toContain('height: 100%');
  });

  it('retains overscroll-behavior: none', () => {
    expect(css).toContain('overscroll-behavior: none');
  });
});

describe('Layout component viewport handling', () => {
  it('uses position:fixed container', () => {
    expect(layout).toContain('fixed');
  });

  it('references visualViewport for dynamic height', () => {
    expect(layout).toContain('visualViewport');
  });

  it('sets height from visualViewport.height', () => {
    expect(layout).toContain('vv.height');
  });

  it('listens for visualViewport resize events', () => {
    expect(layout).toContain("vv.addEventListener('resize'");
  });

  it('does not use scrollTo hack (body scroll is prevented by CSS)', () => {
    expect(layout).not.toContain('scrollTo');
  });
});
