import { useEffect, useRef, useCallback } from 'react';
import type { ContextAction } from '../types';

interface RadialMenuProps {
  open: boolean;
  centerX: number;
  centerY: number;
  onClose: () => void;
  onSendKey: (key: string) => void;
  onKillSession: () => void;
  contextActions: ContextAction[];
  onZoomIn?: () => void;
  onZoomOut?: () => void;
  onUploadImage?: () => void;
}

interface KeyItem {
  label: string;
  key: string;
  variant: 'primary' | 'ghost' | 'danger';
}

// Inner ring — the four always-present core keys at cardinal positions
const INNER_KEYS: KeyItem[] = [
  { label: 'ENTER', key: 'Enter', variant: 'primary' },   // 12 o'clock
  { label: 'C-c', key: 'C-c', variant: 'danger' },        // 3 o'clock
  { label: 'KILL', key: '__kill__', variant: 'danger' },   // 6 o'clock
  { label: 'ESC', key: 'Escape', variant: 'ghost' },       // 9 o'clock
];

// Zoom controls + image upload — always present on outer ring, before any context actions
const ZOOM_ITEMS: KeyItem[] = [
  { label: 'A+', key: '__zoom_in__', variant: 'ghost' },
  { label: 'A-', key: '__zoom_out__', variant: 'ghost' },
  { label: 'IMG', key: '__upload__', variant: 'ghost' },
];

const INNER_RADIUS = 65;
const OUTER_RADIUS = 115;
const KEY_SIZE = 44;

const variantClasses: Record<KeyItem['variant'], string> = {
  primary: 'border-primary text-primary',
  ghost: 'border-border text-text',
  danger: 'border-status-error text-status-error',
};

// Outer ring buttons use brighter colors so they're visible against the dark background
const outerVariantClasses: Record<KeyItem['variant'], string> = {
  primary: 'border-primary text-primary',
  ghost: 'border-primary/60 text-text',
  danger: 'border-status-error text-status-error',
};

function outerAngles(count: number): number[] {
  if (count === 0) return [];
  // Evenly space items starting at top-right (-PI/4 ≈ 1:30 position)
  // For small counts use hand-tuned diagonal positions to avoid
  // overlapping with the inner ring's cardinal buttons.
  if (count <= 4) {
    const diagonals = [-Math.PI / 4, Math.PI / 4, (3 * Math.PI) / 4, (-3 * Math.PI) / 4];
    return diagonals.slice(0, count);
  }
  // 5+ items: evenly spaced around the full circle, starting at top (-PI/2)
  const step = (2 * Math.PI) / count;
  return Array.from({ length: count }, (_, i) => -Math.PI / 2 + i * step);
}

export function RadialMenu({
  open,
  centerX,
  centerY,
  onClose,
  onSendKey,
  onKillSession,
  contextActions,
  onZoomIn,
  onZoomOut,
  onUploadImage,
}: RadialMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);

  // Focus the menu container when it opens
  useEffect(() => {
    if (!open) return;
    menuRef.current?.focus();
  }, [open]);

  // Escape key dismisses menu
  useEffect(() => {
    if (!open) return;

    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };

    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [open, onClose]);

  // Menu stays open after sending a key so users can fire multiple
  // keys in rapid succession without reopening the menu each time.
  const handleKeyClick = useCallback(
    (key: string) => {
      if (key === '__kill__') {
        onClose();
        onKillSession();
      } else if (key === '__zoom_in__') {
        onZoomIn?.();
      } else if (key === '__zoom_out__') {
        onZoomOut?.();
      } else if (key === '__upload__') {
        onClose();
        onUploadImage?.();
      } else {
        onSendKey(key);
      }
    },
    [onSendKey, onKillSession, onClose, onZoomIn, onZoomOut, onUploadImage],
  );

  if (!open) return null;

  // Clamp center so the full radial layout stays within viewport
  const padding = OUTER_RADIUS + KEY_SIZE / 2 + 8;
  const clampedX = Math.max(padding, Math.min(centerX, window.innerWidth - padding));
  const clampedY = Math.max(padding, Math.min(centerY, window.innerHeight - padding));

  // Combine zoom items with context actions for outer ring
  const allOuterItems: KeyItem[] = [...ZOOM_ITEMS, ...contextActions];

  // Outer ring angles
  const angles = outerAngles(allOuterItems.length);

  return (
    <>
      {/* Backdrop -- semi-transparent, click to close, block iOS scroll-through */}
      <div
        className="fixed inset-0 bg-black/40 z-40"
        onClick={onClose}
        onTouchMove={(e) => e.preventDefault()}
      />

      {/* Radial key rings */}
      <div
        ref={menuRef}
        className="fixed z-50 outline-none"
        role="menu"
        aria-label="Special keys"
        tabIndex={-1}
        style={{
          left: clampedX,
          top: clampedY,
          width: 0,
          height: 0,
        }}
      >
        {/* Inner ring — 4 core keys at cardinal positions */}
        {INNER_KEYS.map((item, index) => {
          const angle = -Math.PI / 2 + index * (Math.PI / 2);
          const x = Math.cos(angle) * INNER_RADIUS;
          const y = Math.sin(angle) * INNER_RADIUS;
          const isEscape = item.key === 'Escape';
          const buttonClasses = isEscape
            ? 'border-text-muted text-text'
            : variantClasses[item.variant];

          return (
            <button
              key={item.key}
              type="button"
              role="menuitem"
              onClick={() => handleKeyClick(item.key)}
              className={`absolute flex items-center justify-center rounded-full border bg-background/90 backdrop-blur-sm no-select btn-active radial-key-enter ${buttonClasses}`}
              style={{
                width: KEY_SIZE,
                height: KEY_SIZE,
                left: x - KEY_SIZE / 2,
                top: y - KEY_SIZE / 2,
                animationDelay: `${index * 25}ms`,
                boxShadow: isEscape ? '0 0 8px rgba(255, 255, 255, 0.2)' : undefined,
              }}
              aria-label={item.label}
            >
              <span className="text-[10px] font-bold uppercase leading-none">
                {item.label}
              </span>
            </button>
          );
        })}

        {/* Outer ring — expanding circle that zoom + context keys sit on */}
        {allOuterItems.length > 0 && (
          <div
            className="absolute rounded-full border border-primary/40 outer-ring-circle"
            style={{
              width: OUTER_RADIUS * 2 + KEY_SIZE,
              height: OUTER_RADIUS * 2 + KEY_SIZE,
              left: 0,
              top: 0,
              transformOrigin: 'center',
              pointerEvents: 'none',
              boxShadow: '0 0 12px rgba(0, 255, 65, 0.15), inset 0 0 12px rgba(0, 255, 65, 0.05)',
            }}
          />
        )}

        {/* Outer ring — zoom controls + context-aware actions (appear after ring expands) */}
        {allOuterItems.map((item, index) => {
          const angle = angles[index];
          const x = Math.cos(angle) * OUTER_RADIUS;
          const y = Math.sin(angle) * OUTER_RADIUS;

          return (
            <button
              key={`outer-${item.key}`}
              type="button"
              role="menuitem"
              onClick={() => handleKeyClick(item.key)}
              className={`absolute flex items-center justify-center rounded-full border bg-background/90 backdrop-blur-sm no-select btn-active radial-key-outer-enter ${outerVariantClasses[item.variant]}`}
              style={{
                width: KEY_SIZE,
                height: KEY_SIZE,
                left: x - KEY_SIZE / 2,
                top: y - KEY_SIZE / 2,
                animationDelay: `${250 + index * 50}ms`,
              }}
              aria-label={item.label}
            >
              <span className="text-[10px] font-bold uppercase leading-none">
                {item.label}
              </span>
            </button>
          );
        })}
      </div>
    </>
  );
}
