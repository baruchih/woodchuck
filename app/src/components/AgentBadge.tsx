import type { Agent } from '../types';

/** Marks sessions that don't run Claude Code (the default, left unmarked) */
export function AgentBadge({ agent }: { agent?: Agent }) {
  if (agent !== 'codex') return null;
  return (
    <span
      className="shrink-0 px-1 py-px rounded-sm border border-border text-[9px] font-bold uppercase tracking-wide text-text-muted"
      title="Codex session"
    >
      Codex
    </span>
  );
}
