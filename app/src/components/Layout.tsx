import { type ReactNode, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { ConnectionStatus } from './ConnectionStatus';

interface LayoutProps {
  title: string;
  showBack?: boolean;
  onBack?: () => void;
  rightAction?: ReactNode;
  children: ReactNode;
}

export function Layout({ title, showBack = false, onBack, rightAction, children }: LayoutProps) {
  const navigate = useNavigate();
  const containerRef = useRef<HTMLDivElement>(null);

  const handleBack = onBack ?? (() => {
    navigate('/');
  });

  // Use visualViewport API to handle mobile keyboard resizing.
  // dvh doesn't reliably update on iOS Safari when the keyboard opens,
  // but visualViewport.height always reflects the actual visible area.
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;

    const update = () => {
      if (containerRef.current) {
        containerRef.current.style.height = `${vv.height}px`;
        // Pin the container to the top of the visual viewport.
        // When the keyboard opens, the browser auto-scrolls to keep the
        // focused textarea visible, pushing the page up. Counteract that
        // by offsetting our container to match the viewport's scroll.
        containerRef.current.style.top = `${vv.offsetTop}px`;
      }
    };

    update();
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    return () => {
      vv.removeEventListener('resize', update);
      vv.removeEventListener('scroll', update);
    };
  }, []);

  return (
    <div ref={containerRef} className="fixed inset-x-0 top-0 h-dvh bg-background flex flex-col">
      {/* Header */}
      <header className="bg-surface border-b border-border sticky top-0 z-40 pt-safe">
        <div className="flex items-center justify-between px-4 h-12">
          {/* Left side */}
          <div className="flex items-center gap-3 min-w-0 flex-1">
            {showBack && (
              <button
                onClick={handleBack}
                className="p-2 -ml-2 touch-target btn-active rounded-sm hover:bg-surface-alt text-text-muted hover:text-primary"
                aria-label="Go back"
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="w-5 h-5"
                >
                  <path d="M19 12H5M12 19l-7-7 7-7" />
                </svg>
              </button>
            )}
            <img src="/icons/icon.svg" alt="" className="w-8 h-8 flex-shrink-0" />
            <h1 className="text-sm font-medium text-text uppercase tracking-wider truncate">{title}</h1>
          </div>

          {/* Right side */}
          <div className="flex items-center gap-3 ml-3">
            <ConnectionStatus />
            {rightAction}
          </div>
        </div>
      </header>

      {/* Main content — overflow-auto for scrollable pages, children can set overflow-hidden */}
      <main className="flex-1 flex flex-col min-h-0 overflow-auto">{children}</main>
    </div>
  );
}
