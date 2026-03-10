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
  const { containerRef, write, focus, scrollLines, dimensions } = useXterm({
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

  // Touch handling: single-finger momentum scroll + two-finger pinch-to-zoom
  const momentumRef = useRef(0); // requestAnimationFrame ID

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    // ── Pinch-to-zoom state ──
    let pinchStartDist = 0;
    let lastZoomDirection: 'in' | 'out' | null = null;

    // ── Momentum scroll state ──
    let lastTouchY = 0;
    let lastTouchTime = 0;
    let velocity = 0; // px/ms
    let isSingleFinger = false;
    const lineHeight = fontSize * 1.4; // matches xterm lineHeight

    function getTouchDistance(t1: Touch, t2: Touch): number {
      const dx = t1.clientX - t2.clientX;
      const dy = t1.clientY - t2.clientY;
      return Math.sqrt(dx * dx + dy * dy);
    }

    function stopMomentum() {
      if (momentumRef.current) {
        cancelAnimationFrame(momentumRef.current);
        momentumRef.current = 0;
      }
    }

    function startMomentum(initialVelocity: number) {
      stopMomentum();
      let v = initialVelocity; // px/ms
      let lastTime = performance.now();
      let accumulated = 0;

      const step = (now: number) => {
        const dt = now - lastTime;
        lastTime = now;

        // Decelerate (friction)
        v *= Math.pow(0.95, dt / 16);

        // Stop when slow enough
        if (Math.abs(v) < 0.01) {
          momentumRef.current = 0;
          return;
        }

        // Accumulate sub-line pixel movement and scroll whole lines
        accumulated += v * dt;
        const lines = Math.trunc(accumulated / lineHeight);
        if (lines !== 0) {
          scrollLines(-lines); // negative because swipe up = scroll up = negative velocity
          accumulated -= lines * lineHeight;
        }

        momentumRef.current = requestAnimationFrame(step);
      };

      momentumRef.current = requestAnimationFrame(step);
    }

    const handleTouchStart = (e: TouchEvent) => {
      stopMomentum();

      if (e.touches.length === 2) {
        isSingleFinger = false;
        const dist = getTouchDistance(e.touches[0], e.touches[1]);
        if (dist < 1) return;
        pinchStartDist = dist;
        lastZoomDirection = null;
      } else if (e.touches.length === 1) {
        isSingleFinger = true;
        lastTouchY = e.touches[0].clientY;
        lastTouchTime = performance.now();
        velocity = 0;
      }
    };

    const handleTouchMove = (e: TouchEvent) => {
      if (e.touches.length === 2 && pinchStartDist > 0) {
        // Pinch-to-zoom
        isSingleFinger = false;
        e.preventDefault();
        const currentDist = getTouchDistance(e.touches[0], e.touches[1]);
        const scale = currentDist / pinchStartDist;
        const direction: 'in' | 'out' = scale > 1 ? 'in' : 'out';
        const threshold = 1.15;
        if (
          (scale > threshold && direction !== lastZoomDirection && direction === 'in') ||
          (scale < 1 / threshold && direction !== lastZoomDirection && direction === 'out')
        ) {
          lastZoomDirection = direction;
          if (direction === 'in') onZoomIn();
          else onZoomOut();
          pinchStartDist = currentDist;
        }
      } else if (e.touches.length === 1 && isSingleFinger) {
        // Single-finger scroll
        e.preventDefault();
        const touchY = e.touches[0].clientY;
        const now = performance.now();
        const deltaY = lastTouchY - touchY;
        const dt = now - lastTouchTime;

        if (dt > 0) {
          // Exponential moving average for smooth velocity
          const instantV = deltaY / dt;
          velocity = velocity * 0.6 + instantV * 0.4;
        }

        // Scroll by pixel delta converted to lines
        const lines = Math.round(deltaY / lineHeight);
        if (lines !== 0) {
          scrollLines(lines);
        }

        lastTouchY = touchY;
        lastTouchTime = now;
      }
    };

    const handleTouchEnd = (e: TouchEvent) => {
      if (e.touches.length < 2) {
        pinchStartDist = 0;
        lastZoomDirection = null;
      }

      if (e.touches.length === 0 && isSingleFinger) {
        isSingleFinger = false;
        // Start momentum if there's enough velocity
        if (Math.abs(velocity) > 0.1) {
          startMomentum(velocity);
        }
      }
    };

    container.addEventListener('touchstart', handleTouchStart, { passive: true });
    container.addEventListener('touchmove', handleTouchMove, { passive: false });
    container.addEventListener('touchend', handleTouchEnd, { passive: true });

    return () => {
      stopMomentum();
      container.removeEventListener('touchstart', handleTouchStart);
      container.removeEventListener('touchmove', handleTouchMove);
      container.removeEventListener('touchend', handleTouchEnd);
    };
  }, [containerRef, fontSize, scrollLines, onZoomIn, onZoomOut]);

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
