import type { Session, SessionStatus } from '../types';

interface NotificationItem {
  sessionId: string;
  sessionName: string;
  status: 'needs_input' | 'error';
}

interface NotificationBannerProps {
  sessions: Session[];
  dismissedIds: Set<string>;
  onDismiss: (sessionId: string) => void;
  onTap: (sessionId: string) => void;
}

const NOTIFY_STATUSES: Set<SessionStatus> = new Set(['needs_input', 'error']);

export function NotificationBanner({ sessions, dismissedIds, onDismiss, onTap }: NotificationBannerProps) {
  const items: NotificationItem[] = sessions
    .filter((s) => NOTIFY_STATUSES.has(s.status) && !dismissedIds.has(s.id))
    .map((s) => ({
      sessionId: s.id,
      sessionName: s.name,
      status: s.status as 'needs_input' | 'error',
    }));

  if (items.length === 0) return null;

  return (
    <div className="px-4 pt-2 space-y-2 banner-slide-in">
      {items.map((item) => (
        <div
          key={item.sessionId}
          className={`flex items-center justify-between rounded-sm border p-3 cursor-pointer ${
            item.status === 'error'
              ? 'bg-status-error/10 border-status-error/30'
              : 'bg-amber-500/10 border-amber-500/30'
          }`}
          onClick={() => onTap(item.sessionId)}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') onTap(item.sessionId);
          }}
        >
          <div className="flex items-center gap-2 min-w-0">
            <span
              className={`text-xs ${
                item.status === 'error' ? 'text-status-error' : 'text-amber-400'
              }`}
            >
              {item.status === 'error' ? 'Error' : 'Needs input'}
            </span>
            <span className="text-xs text-text-muted truncate">{item.sessionName}</span>
          </div>
          <button
            className="text-text-muted hover:text-text p-1 -mr-1 touch-target flex items-center justify-center"
            onClick={(e) => {
              e.stopPropagation();
              onDismiss(item.sessionId);
            }}
            aria-label={`Dismiss notification for ${item.sessionName}`}
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="w-4 h-4"
            >
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </div>
      ))}
    </div>
  );
}
