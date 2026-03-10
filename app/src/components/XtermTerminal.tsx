import { useEffect, useRef, useCallback } from 'react';
import '@xterm/xterm/css/xterm.css';
import { useXterm } from '../hooks/useXterm';

// ── Interface ──

export interface XtermTerminalProps {
  sessionId: string;
  content: string;
  fontSize: number;
  onInput: (data: string) => void;
  onResize: (cols: number, rows: number) => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  /** When true, tapping the terminal won't open the keyboard (mobile input bar handles input) */
  disableKeyboard?: boolean;
  className?: string;
}

// ── Component ──

export function XtermTerminal({
  content,
  fontSize,
  onInput,
  onResize,
  onZoomIn,
  onZoomOut,
  disableKeyboard = false,
  className = '',
}: XtermTerminalProps) {
  const { containerRef, write, focus, dimensions } = useXterm({
    fontSize,
    onInput,
    onResize,
  });

  // Track font size for pinch calculations
  const fontSizeRef = useRef(fontSize);
  fontSizeRef.current = fontSize;

  // Write content when it changes
  useEffect(() => {
    write(content);
  }, [content, write]);

  // Pinch-to-zoom handling
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let pinchStartDist = 0;
    let lastZoomDirection: 'in' | 'out' | null = null;

    function getTouchDistance(t1: Touch, t2: Touch): number {
      const dx = t1.clientX - t2.clientX;
      const dy = t1.clientY - t2.clientY;
      return Math.sqrt(dx * dx + dy * dy);
    }

    const handleTouchStart = (e: TouchEvent) => {
      if (e.touches.length === 2) {
        const dist = getTouchDistance(e.touches[0], e.touches[1]);
        if (dist < 1) return;
        pinchStartDist = dist;
        lastZoomDirection = null;
      }
    };

    const handleTouchMove = (e: TouchEvent) => {
      if (e.touches.length === 2 && pinchStartDist > 0) {
        e.preventDefault();
        const currentDist = getTouchDistance(e.touches[0], e.touches[1]);
        const scale = currentDist / pinchStartDist;

        // Determine zoom direction based on scale
        const direction: 'in' | 'out' = scale > 1 ? 'in' : 'out';

        // Only trigger zoom when scale crosses threshold and direction changes
        const threshold = 1.15;
        if (
          (scale > threshold && direction !== lastZoomDirection && direction === 'in') ||
          (scale < 1 / threshold && direction !== lastZoomDirection && direction === 'out')
        ) {
          lastZoomDirection = direction;
          if (direction === 'in') {
            onZoomIn();
          } else {
            onZoomOut();
          }
          // Reset base for next step
          pinchStartDist = currentDist;
        }
      }
    };

    const handleTouchEnd = (e: TouchEvent) => {
      if (e.touches.length < 2) {
        pinchStartDist = 0;
        lastZoomDirection = null;
      }
    };

    container.addEventListener('touchstart', handleTouchStart, { passive: true });
    container.addEventListener('touchmove', handleTouchMove, { passive: false });
    container.addEventListener('touchend', handleTouchEnd, { passive: true });

    return () => {
      container.removeEventListener('touchstart', handleTouchStart);
      container.removeEventListener('touchmove', handleTouchMove);
      container.removeEventListener('touchend', handleTouchEnd);
    };
  }, [containerRef, onZoomIn, onZoomOut]);

  // Handle click to focus (disabled on mobile where input bar handles input)
  const handleClick = useCallback(() => {
    if (disableKeyboard) return;
    // Don't focus if user is selecting text
    if (window.getSelection()?.toString()) return;
    focus();
  }, [focus, disableKeyboard]);

  return (
    <div
      ref={containerRef}
      className={`w-full h-full min-h-[200px] bg-background ${className}`}
      onClick={handleClick}
      data-dimensions={dimensions ? `${dimensions.cols}x${dimensions.rows}` : ''}
    />
  );
}
