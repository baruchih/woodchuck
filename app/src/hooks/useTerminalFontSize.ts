import { useState, useCallback } from 'react';

// ── Constants ──

const FONT_STEPS = [10, 12, 14, 16, 18, 20, 24];
const DEFAULT_FONT_SIZE = 12;
const STORAGE_KEY = 'woodchuck:terminal-font-size';

// ── Interface ──

interface UseTerminalFontSizeReturn {
  fontSize: number;
  zoomIn: () => void;
  zoomOut: () => void;
  setByPinchScale: (scale: number, baseFontSize: number) => void;
}

// ── Utilities ──

function snapToStep(rawPx: number): number {
  let closest = FONT_STEPS[0];
  let minDist = Math.abs(rawPx - closest);

  for (let i = 1; i < FONT_STEPS.length; i++) {
    const dist = Math.abs(rawPx - FONT_STEPS[i]);
    if (dist < minDist) {
      minDist = dist;
      closest = FONT_STEPS[i];
    }
  }

  return closest;
}

function loadFontSize(): number {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      const parsed = Number(stored);
      if (FONT_STEPS.includes(parsed)) {
        return parsed;
      }
    }
  } catch {
    // Ignore storage errors
  }
  return DEFAULT_FONT_SIZE;
}

function saveFontSize(size: number): void {
  try {
    localStorage.setItem(STORAGE_KEY, String(size));
  } catch {
    // Ignore storage errors
  }
}

// ── Hook ──

export function useTerminalFontSize(): UseTerminalFontSizeReturn {
  const [fontSize, setFontSize] = useState(loadFontSize);

  const zoomIn = useCallback(() => {
    setFontSize((prev) => {
      const idx = FONT_STEPS.indexOf(prev);
      if (idx < 0 || idx >= FONT_STEPS.length - 1) return prev;
      const next = FONT_STEPS[idx + 1];
      saveFontSize(next);
      return next;
    });
  }, []);

  const zoomOut = useCallback(() => {
    setFontSize((prev) => {
      const idx = FONT_STEPS.indexOf(prev);
      if (idx <= 0) return prev;
      const next = FONT_STEPS[idx - 1];
      saveFontSize(next);
      return next;
    });
  }, []);

  const setByPinchScale = useCallback((scale: number, baseFontSize: number) => {
    const rawPx = baseFontSize * scale;
    const snapped = snapToStep(rawPx);
    setFontSize((prev) => {
      if (snapped === prev) return prev;
      saveFontSize(snapped);
      return snapped;
    });
  }, []);

  return { fontSize, zoomIn, zoomOut, setByPinchScale };
}
