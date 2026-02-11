import { useState, useEffect } from 'react';
import type { SessionStatus } from '../types';

interface StatusBadgeProps {
  status: SessionStatus;
  size?: 'sm' | 'md';
  workingSince?: string;
}

const statusColors: Record<SessionStatus, string> = {
  resting: 'text-status-resting',
  working: 'text-status-working',
  needs_input: 'text-status-needs-input animate-pulse-status',
  error: 'text-status-error',
};

const statusLabels: Record<SessionStatus, string> = {
  resting: 'Resting',
  working: 'Working',
  needs_input: 'Needs input',
  error: 'Error',
};

const glowStatuses: Set<SessionStatus> = new Set(['working', 'needs_input']);

const timerBehavior: Record<SessionStatus, 'counting' | 'frozen' | 'none'> = {
  working: 'counting',
  needs_input: 'frozen',
  error: 'none',
  resting: 'none',
};

function formatDuration(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

export function StatusBadge({ status, size = 'md', workingSince }: StatusBadgeProps) {
  const [elapsed, setElapsed] = useState<number>(0);
  const behavior = timerBehavior[status];

  useEffect(() => {
    // No timer for 'none' behavior or missing workingSince
    if (behavior === 'none' || !workingSince) {
      setElapsed(0);
      return;
    }

    const calcElapsed = () => Math.max(0, Math.floor((Date.now() - new Date(workingSince).getTime()) / 1000));

    // Calculate immediately so we don't show 0:00 for the first second
    setElapsed(calcElapsed());

    // Only create interval for 'counting' behavior
    if (behavior === 'counting') {
      const interval = setInterval(() => {
        setElapsed(calcElapsed());
      }, 1000);

      return () => {
        clearInterval(interval);
      };
    }
    // For 'frozen' behavior, we calculated once above but don't create interval
  }, [workingSince, status, behavior]);

  const dotSize = size === 'sm' ? 'w-2 h-2' : 'w-2.5 h-2.5';
  const textSize = size === 'sm' ? 'text-xs' : 'text-xs';
  const shouldGlow = glowStatuses.has(status);

  return (
    <span
      className={`inline-flex items-center gap-2 font-medium no-select ${statusColors[status]} ${textSize}`}
    >
      <span className={`${dotSize} rounded-full bg-current ${shouldGlow ? 'glow' : ''}`} />
      {statusLabels[status]}{timerBehavior[status] !== 'none' && workingSince && ` (${formatDuration(elapsed)})`}
    </span>
  );
}
