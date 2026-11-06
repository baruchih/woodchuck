import type { Attachment } from '../utils/attachments';

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

interface AttachmentChipsProps {
  attachments: Attachment[];
  onRemove: (id: string) => void;
  disabled?: boolean;
  compact?: boolean;
}

/** Staged attachments shown above an input box, each removable before sending */
export function AttachmentChips({ attachments, onRemove, disabled, compact }: AttachmentChipsProps) {
  if (attachments.length === 0) return null;
  const text = compact ? 'text-[10px]' : 'text-xs';

  return (
    <div className={`flex flex-wrap gap-1 ${compact ? 'px-1.5 pt-1' : 'px-2 pt-1.5'}`}>
      {attachments.map((a) => (
        <span
          key={a.id}
          className={`flex items-center gap-1 max-w-full rounded border border-border bg-background pl-1.5 ${text} text-text`}
        >
          <span aria-hidden className="text-text-muted">{a.image ? '🖼' : '📄'}</span>
          <span className="truncate max-w-[12rem]">{a.file.name}</span>
          <span className="text-text-muted shrink-0">{formatSize(a.file.size)}</span>
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onRemove(a.id); }}
            disabled={disabled}
            className="px-1.5 py-0.5 text-text-muted hover:text-status-error disabled:opacity-30"
            aria-label={`Remove ${a.file.name}`}
          >
            &times;
          </button>
        </span>
      ))}
    </div>
  );
}
