import type { ReactNode } from 'react';
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

  const handleBack = onBack ?? (() => {
    navigate('/');
  });

  return (
    <div className="h-dvh bg-background flex flex-col overflow-hidden">
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

      {/* Main content */}
      <main className="flex-1 flex flex-col min-h-0 overflow-auto">{children}</main>
    </div>
  );
}
