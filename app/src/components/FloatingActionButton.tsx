import { useCallback, useEffect } from 'react';
import { useDraggable } from '../hooks/useDraggable';

interface FloatingActionButtonProps {
  onTap: () => void;
  onCenterChange: (cx: number, cy: number) => void;
  menuOpen: boolean;
  needsAttention: boolean;
  hasText: boolean;
  hasContextActions: boolean;
}

const FAB_SIZE = 56; // w-14 = 56px
const DEFAULT_POSITION = {
  x: typeof window !== 'undefined' ? window.innerWidth - 72 : 300,
  y: typeof window !== 'undefined' ? window.innerHeight - 160 : 500,
};

export function FloatingActionButton({
  onTap,
  onCenterChange,
  menuOpen,
  needsAttention,
  hasText,
  hasContextActions,
}: FloatingActionButtonProps) {
  const { position, isDragging, isDraggingRef, handlePointerDown: dragPointerDown } = useDraggable({
    storageKey: 'woodchuck:fab-position',
    defaultPosition: DEFAULT_POSITION,
  });

  // Report center position to parent whenever it changes
  useEffect(() => {
    onCenterChange(position.x + FAB_SIZE / 2, position.y + FAB_SIZE / 2);
  }, [position.x, position.y, onCenterChange]);

  const handlePointerUp = useCallback(() => {
    if (isDraggingRef.current) return;
    onTap();
  }, [onTap]);

  return (
    <button
      type="button"
      onPointerDown={dragPointerDown}
      onPointerUp={handlePointerUp}
      style={{
        position: 'fixed',
        left: position.x,
        top: position.y,
        touchAction: 'none',
      }}
      className={`w-14 h-14 rounded-full flex items-center justify-center shadow-lg z-50 no-select ${
        menuOpen
          ? 'bg-surface border border-border text-text'
          : 'bg-primary text-background'
      } ${
        isDragging ? 'scale-110 opacity-90' : 'transition-all duration-300'
      } ${needsAttention && !menuOpen ? 'fab-attention' : ''}`}
      aria-label={menuOpen ? 'Close menu' : 'Terminal actions'}
    >
      {menuOpen ? (
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5">
          <path d="M18 6L6 18M6 6l12 12" />
        </svg>
      ) : (
        <span className="text-lg font-bold leading-none">&gt;_</span>
      )}

      {/* Text badge — only show when menu is closed */}
      {hasText && !menuOpen && (
        <span className="absolute -top-1 -right-1 w-3 h-3 rounded-full bg-status-needs-input" />
      )}

      {/* Context actions pip — only show when menu is closed */}
      {hasContextActions && !menuOpen && (
        <span className="absolute -bottom-1 -left-1 w-2 h-2 rounded-full bg-primary" />
      )}
    </button>
  );
}
