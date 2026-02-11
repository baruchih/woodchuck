import { useState, useRef, useCallback, useEffect } from 'react';

interface UseDraggableOptions {
  storageKey: string;
  defaultPosition: { x: number; y: number };
  boundaryPadding?: number;
}

interface UseDraggableReturn {
  position: { x: number; y: number };
  isDragging: boolean;
  isDraggingRef: React.RefObject<boolean>;
  handlePointerDown: (e: React.PointerEvent) => void;
}

function clampPosition(
  x: number,
  y: number,
  elementSize: number,
  padding: number,
): { x: number; y: number } {
  const maxX = window.innerWidth - elementSize - padding;
  const maxY = window.innerHeight - elementSize - padding;
  return {
    x: Math.max(padding, Math.min(x, maxX)),
    y: Math.max(padding, Math.min(y, maxY)),
  };
}

function loadPosition(
  storageKey: string,
  defaultPos: { x: number; y: number },
  elementSize: number,
  padding: number,
): { x: number; y: number } {
  try {
    const stored = localStorage.getItem(storageKey);
    if (stored) {
      const parsed = JSON.parse(stored);
      if (typeof parsed.x === 'number' && typeof parsed.y === 'number') {
        return clampPosition(parsed.x, parsed.y, elementSize, padding);
      }
    }
  } catch {
    // Ignore parse errors
  }
  return clampPosition(defaultPos.x, defaultPos.y, elementSize, padding);
}

const ELEMENT_SIZE = 56; // FAB diameter in px
const DRAG_THRESHOLD = 8; // px movement to distinguish tap from drag

export function useDraggable(options: UseDraggableOptions): UseDraggableReturn {
  const { storageKey, defaultPosition, boundaryPadding = 16 } = options;

  const [position, setPosition] = useState(() =>
    loadPosition(storageKey, defaultPosition, ELEMENT_SIZE, boundaryPadding)
  );
  const [isDragging, setIsDragging] = useState(false);

  // Refs for stable access in window-level event handlers
  const positionRef = useRef(position);
  positionRef.current = position;

  const isDraggingRef = useRef(false);
  const startPosRef = useRef({ x: 0, y: 0 });
  const startPointerRef = useRef({ x: 0, y: 0 });
  const listenersAttachedRef = useRef(false);

  const handlePointerMove = useCallback((e: PointerEvent) => {
    const dx = e.clientX - startPointerRef.current.x;
    const dy = e.clientY - startPointerRef.current.y;

    if (!isDraggingRef.current && (Math.abs(dx) > DRAG_THRESHOLD || Math.abs(dy) > DRAG_THRESHOLD)) {
      isDraggingRef.current = true;
      setIsDragging(true);
    }

    if (isDraggingRef.current) {
      const newX = startPosRef.current.x + dx;
      const newY = startPosRef.current.y + dy;
      const clamped = clampPosition(newX, newY, ELEMENT_SIZE, boundaryPadding);
      setPosition(clamped);
    }
  }, [boundaryPadding]);

  const removeListeners = useCallback(() => {
    if (listenersAttachedRef.current) {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
      listenersAttachedRef.current = false;
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handlePointerMove]);

  const handlePointerUp = useCallback(() => {
    removeListeners();

    if (isDraggingRef.current) {
      // Persist position from ref (no side effect in setState updater)
      try {
        localStorage.setItem(storageKey, JSON.stringify(positionRef.current));
      } catch {
        // Ignore storage errors
      }
    }

    isDraggingRef.current = false;
    setIsDragging(false);
  }, [removeListeners, storageKey]);

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    startPointerRef.current = { x: e.clientX, y: e.clientY };
    startPosRef.current = { ...positionRef.current };
    isDraggingRef.current = false;

    listenersAttachedRef.current = true;
    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
  }, [handlePointerMove, handlePointerUp]);

  // Cleanup window listeners on unmount
  useEffect(() => {
    return () => {
      if (listenersAttachedRef.current) {
        window.removeEventListener('pointermove', handlePointerMove);
        window.removeEventListener('pointerup', handlePointerUp);
      }
    };
  }, [handlePointerMove, handlePointerUp]);

  // Re-clamp position on viewport resize
  useEffect(() => {
    const handleResize = () => {
      setPosition((prev) => clampPosition(prev.x, prev.y, ELEMENT_SIZE, boundaryPadding));
    };

    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [boundaryPadding]);

  return { position, isDragging, isDraggingRef, handlePointerDown };
}
