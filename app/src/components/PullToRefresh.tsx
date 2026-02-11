import { useState, useRef, type ReactNode, type TouchEvent } from 'react';

interface PullToRefreshProps {
  onRefresh: () => Promise<void>;
  children: ReactNode;
}

const THRESHOLD = 80; // px to trigger refresh
const RESISTANCE = 2.5; // resistance factor for pull

export function PullToRefresh({ onRefresh, children }: PullToRefreshProps) {
  const [pulling, setPulling] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [pullDistance, setPullDistance] = useState(0);

  const containerRef = useRef<HTMLDivElement>(null);
  const startYRef = useRef(0);
  const isPullingRef = useRef(false);

  const handleTouchStart = (e: TouchEvent<HTMLDivElement>) => {
    const container = containerRef.current;
    if (!container || refreshing) return;

    // Only enable pull-to-refresh when scrolled to top
    if (container.scrollTop === 0) {
      startYRef.current = e.touches[0].clientY;
      isPullingRef.current = true;
    }
  };

  const handleTouchMove = (e: TouchEvent<HTMLDivElement>) => {
    if (!isPullingRef.current || refreshing) return;

    const currentY = e.touches[0].clientY;
    const diff = currentY - startYRef.current;

    if (diff > 0) {
      // Apply resistance
      const distance = diff / RESISTANCE;
      setPullDistance(Math.min(distance, THRESHOLD * 1.5));
      setPulling(true);
    }
  };

  const handleTouchEnd = async () => {
    if (!isPullingRef.current) return;

    isPullingRef.current = false;

    if (pullDistance >= THRESHOLD && !refreshing) {
      setRefreshing(true);
      try {
        await onRefresh();
      } finally {
        setRefreshing(false);
      }
    }

    setPulling(false);
    setPullDistance(0);
  };

  return (
    <div
      ref={containerRef}
      className="h-full overflow-y-auto"
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
    >
      {/* Pull indicator */}
      <div
        className="pull-indicator overflow-hidden"
        style={{
          height: pulling || refreshing ? Math.max(pullDistance, refreshing ? 48 : 0) : 0,
          transition: pulling ? 'none' : 'height 0.2s ease-out',
        }}
      >
        <div className="flex items-center justify-center h-12">
          {refreshing ? (
            <div className="spinner" />
          ) : (
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="w-5 h-5 text-text-muted"
              style={{
                transform: `rotate(${pullDistance >= THRESHOLD ? 180 : 0}deg)`,
                transition: 'transform 0.2s',
              }}
            >
              <path d="M12 5v14M19 12l-7 7-7-7" />
            </svg>
          )}
        </div>
      </div>

      {/* Content */}
      <div
        style={{
          transform: pulling ? `translateY(0)` : 'translateY(0)',
          transition: pulling ? 'none' : 'transform 0.2s ease-out',
        }}
      >
        {children}
      </div>
    </div>
  );
}
