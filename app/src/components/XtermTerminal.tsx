import { useEffect, useCallback, useState, useRef } from 'react';
import '@xterm/xterm/css/xterm.css';
import { useXterm } from '../hooks/useXterm';
import { useWS } from '../context/WebSocketContext';
import { api } from '../api/client';
import { INPUT_MAX_BYTES, inputBytes } from '../utils/inputLimit';

// ── Interface ──

export interface XtermTerminalProps {
  /** Session whose live terminal stream is rendered */
  sessionId: string;
  fontSize: number;
  onInput: (data: string) => void;
  onResize: (cols: number, rows: number) => void;
  /** Receives the visible screen text after it changes */
  onScreenChange?: (text: string) => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  /** When true, tapping the terminal won't open the keyboard (mobile input bar handles input) */
  disableKeyboard?: boolean;
  className?: string;
}

// ── Component ──

export function XtermTerminal({
  sessionId,
  fontSize,
  onInput,
  onResize,
  onScreenChange,
  onZoomIn,
  onZoomOut,
  disableKeyboard = false,
  className = '',
}: XtermTerminalProps) {
  const { onTerminal, pasteInput } = useWS();
  // Text a program copied that the browser wouldn't let us write without a tap
  const [blockedCopy, setBlockedCopy] = useState<string | null>(null);
  const [pasteStatus, setPasteStatus] = useState<{ text: string; error?: boolean } | null>(null);

  // Pasted images are uploaded to the server and their paths pasted into the session:
  // Claude Code turns a pasted image path into an attachment. Text goes in as one paste.
  const handlePaste = useCallback(async ({ images, text }: { images: File[]; text: string }) => {
    if (images.length === 0) {
      if (inputBytes(text) > INPUT_MAX_BYTES) {
        setPasteStatus({ text: 'Paste too long — upload it as a file instead', error: true });
        return;
      }
      pasteInput(sessionId, text);
      return;
    }
    setPasteStatus({ text: images.length === 1 ? 'Uploading image…' : `Uploading ${images.length} images…` });
    try {
      for (const image of images) {
        const { path } = await api.uploadImage(sessionId, image);
        pasteInput(sessionId, path);
      }
      setPasteStatus(null);
    } catch {
      setPasteStatus({ text: 'Image upload failed', error: true });
    }
  }, [sessionId, pasteInput]);

  useEffect(() => {
    if (!pasteStatus?.error) return;
    const timer = setTimeout(() => setPasteStatus(null), 4000);
    return () => clearTimeout(timer);
  }, [pasteStatus]);
  const { containerRef, writeData, focus, scrollLines, isMouseTracking, getTextContent, dimensions } = useXterm({
    fontSize,
    onInput,
    onResize,
    onCopyBlocked: setBlockedCopy,
    onScreenChange,
    onPaste: handlePaste,
  });

  // ── Selectable text overlay (long-press to activate) ──
  const [selectMode, setSelectMode] = useState(false);
  const [selectableText, setSelectableText] = useState('');
  const [selectViewportLine, setSelectViewportLine] = useState(0);
  const selectPreRef = useRef<HTMLPreElement>(null);

  // Render the session's live terminal stream (snapshots on (re)subscribe, then raw output)
  useEffect(() => {
    return onTerminal((msg) => {
      if (msg.session_id === sessionId) writeData(msg.data, msg.reset);
    });
  }, [sessionId, onTerminal, writeData]);

  // Touch handling: single-finger momentum scroll + two-finger pinch-to-zoom + long-press select
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    // ── Pinch-to-zoom state ──
    let pinchStartDist = 0;
    let lastZoomDirection: 'in' | 'out' | null = null;
    let isPinching = false;

    // ── Momentum scroll state ──
    let lastTouchY = 0;
    let lastTouchTime = 0;
    let velocityY = 0; // px/ms
    let momentumRaf = 0;
    let isSingleFingerScrolling = false;
    // Accumulated sub-line pixel remainder for smooth scrolling
    let pixelRemainder = 0;

    // ── Long-press state ──
    let longPressTimer = 0;
    let touchMoved = false;

    // Approximate pixels per terminal line (fontSize * lineHeight)
    const pxPerLine = fontSize * 1.4;

    function getTouchDistance(t1: Touch, t2: Touch): number {
      const dx = t1.clientX - t2.clientX;
      const dy = t1.clientY - t2.clientY;
      return Math.sqrt(dx * dx + dy * dy);
    }

    function stopMomentum() {
      if (momentumRaf) {
        cancelAnimationFrame(momentumRaf);
        momentumRaf = 0;
      }
      velocityY = 0;
      pixelRemainder = 0;
    }

    function clearLongPress() {
      if (longPressTimer) {
        clearTimeout(longPressTimer);
        longPressTimer = 0;
      }
    }

    const handleTouchStart = (e: TouchEvent) => {
      stopMomentum();
      clearLongPress();
      touchMoved = false;

      if (e.touches.length === 1) {
        isSingleFingerScrolling = true;
        lastTouchY = e.touches[0].clientY;
        lastTouchTime = performance.now();
        velocityY = 0;

        // Start long-press timer (500ms hold without moving)
        longPressTimer = window.setTimeout(() => {
          if (!touchMoved) {
            const { text, viewportLine } = getTextContent();
            setSelectableText(text);
            setSelectViewportLine(viewportLine);
            setSelectMode(true);
          }
        }, 500);
      } else if (e.touches.length === 2) {
        clearLongPress();
        isSingleFingerScrolling = false;
        isPinching = true;
        const dist = getTouchDistance(e.touches[0], e.touches[1]);
        if (dist < 1) return;
        pinchStartDist = dist;
        lastZoomDirection = null;
      }
    };

    const handleTouchMove = (e: TouchEvent) => {
      // Any movement cancels long-press
      if (!touchMoved) {
        touchMoved = true;
        clearLongPress();
      }

      // Pinch-to-zoom
      if (e.touches.length === 2 && isPinching && pinchStartDist > 0) {
        e.preventDefault();
        isSingleFingerScrolling = false;
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
        return;
      }

      // Single-finger scroll — track velocity for momentum
      if (e.touches.length === 1 && isSingleFingerScrolling) {
        const touchY = e.touches[0].clientY;
        const now = performance.now();
        const dt = now - lastTouchTime;

        if (dt > 0) {
          const dy = lastTouchY - touchY; // positive = finger moved up = scroll down
          // Exponential moving average for smoother velocity
          const instantVelocity = dy / dt;
          velocityY = velocityY * 0.6 + instantVelocity * 0.4;
        }

        // xterm.js handles touch-drag scrolling of its own scrollback, but not
        // when the app tracks the mouse — then drag scrolls the app via wheel events
        if (isMouseTracking()) {
          e.preventDefault();
          pixelRemainder += lastTouchY - touchY;
          const lines = Math.trunc(pixelRemainder / pxPerLine);
          if (lines !== 0) {
            scrollLines(lines);
            pixelRemainder -= lines * pxPerLine;
          }
        }

        lastTouchY = touchY;
        lastTouchTime = now;
      }
    };

    const handleTouchEnd = (e: TouchEvent) => {
      clearLongPress();

      if (e.touches.length < 2) {
        pinchStartDist = 0;
        lastZoomDirection = null;
        isPinching = false;
      }

      // Start momentum if we had meaningful velocity
      if (isSingleFingerScrolling && e.touches.length === 0) {
        isSingleFingerScrolling = false;
        const absV = Math.abs(velocityY);
        // Only start momentum if velocity is meaningful (> 0.3 px/ms ≈ 300px/s)
        if (absV > 0.3) {
          pixelRemainder = 0;
          const friction = 0.95; // decay factor per frame (~60fps)
          const minVelocity = 0.05; // stop threshold px/ms

          let lastFrameTime = performance.now();

          const tick = () => {
            const now = performance.now();
            const frameDt = now - lastFrameTime;
            lastFrameTime = now;

            // Apply friction
            velocityY *= friction;

            if (Math.abs(velocityY) < minVelocity) {
              velocityY = 0;
              pixelRemainder = 0;
              return;
            }

            // Convert velocity to pixels moved this frame
            const pxDelta = velocityY * frameDt;
            pixelRemainder += pxDelta;

            // Convert accumulated pixels to whole lines
            const lines = Math.trunc(pixelRemainder / pxPerLine);
            if (lines !== 0) {
              scrollLines(lines);
              pixelRemainder -= lines * pxPerLine;
            }

            momentumRaf = requestAnimationFrame(tick);
          };

          momentumRaf = requestAnimationFrame(tick);
        }
      }
    };

    container.addEventListener('touchstart', handleTouchStart, { passive: true });
    container.addEventListener('touchmove', handleTouchMove, { passive: false });
    container.addEventListener('touchend', handleTouchEnd, { passive: true });

    return () => {
      stopMomentum();
      clearLongPress();
      container.removeEventListener('touchstart', handleTouchStart);
      container.removeEventListener('touchmove', handleTouchMove);
      container.removeEventListener('touchend', handleTouchEnd);
    };
  }, [containerRef, onZoomIn, onZoomOut, fontSize, scrollLines, isMouseTracking, getTextContent]);

  // Scroll the select overlay to match the terminal viewport position
  useEffect(() => {
    if (selectMode && selectPreRef.current) {
      const lineHeight = fontSize * 1.4;
      selectPreRef.current.scrollTop = selectViewportLine * lineHeight;
    }
  }, [selectMode, selectViewportLine, fontSize]);

  // Handle click to focus (disabled on mobile where input bar handles input)
  const handleClick = useCallback(() => {
    if (disableKeyboard) return;
    // Don't focus if user is selecting text
    if (window.getSelection()?.toString()) return;
    focus();
  }, [focus, disableKeyboard]);

  return (
    <>
      <div
        ref={containerRef}
        className={`w-full h-full min-h-[200px] bg-background ${className}`}
        onClick={handleClick}
        data-dimensions={dimensions ? `${dimensions.cols}x${dimensions.rows}` : ''}
      />

      {pasteStatus && (
        <div
          className={`fixed bottom-24 left-1/2 -translate-x-1/2 z-50 px-3 py-1.5 rounded border bg-surface text-xs shadow ${
            pasteStatus.error ? 'border-status-error text-status-error' : 'border-border text-text-muted'
          }`}
          role="status"
        >
          {pasteStatus.text}
        </div>
      )}

      {/* Clipboard write needs a user gesture on some browsers (Safari/iOS) */}
      {blockedCopy !== null && (
        <button
          type="button"
          className="fixed bottom-24 left-1/2 -translate-x-1/2 z-50 px-3 py-1.5 rounded border border-primary bg-surface text-xs font-medium text-primary shadow"
          onClick={(e) => {
            e.stopPropagation();
            navigator.clipboard?.writeText(blockedCopy).catch(() => {});
            setBlockedCopy(null);
          }}
        >
          Tap to copy selection
        </button>
      )}

      {/* Selectable text overlay — triggered by long-press */}
      {selectMode && (
        <div
          className="fixed inset-0 z-50 flex flex-col bg-background"
          onClick={(e) => {
            // Close if tapping the backdrop (not selecting text)
            if (!window.getSelection()?.toString()) {
              e.stopPropagation();
              setSelectMode(false);
            }
          }}
        >
          <div className="flex items-center justify-between px-3 py-2 border-b border-border shrink-0">
            <span className="text-xs text-text-muted">Select text to copy</span>
            <button
              onClick={(e) => { e.stopPropagation(); setSelectMode(false); }}
              className="text-xs font-medium text-primary px-2 py-1"
            >
              Done
            </button>
          </div>
          <pre
            ref={selectPreRef}
            className="flex-1 overflow-auto p-3 text-text font-mono whitespace-pre select-text"
            style={{ fontSize: `${fontSize}px`, lineHeight: 1.4, userSelect: 'text', WebkitUserSelect: 'text' }}
          >
            {selectableText}
          </pre>
        </div>
      )}
    </>
  );
}
