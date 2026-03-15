import { useState, useEffect, useCallback } from 'react';
import { api } from '../api/client';
import type { FileEntry } from '../types';

interface FileBrowserProps {
  sessionId: string;
  onClose: () => void;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

export function FileBrowser({ sessionId, onClose }: FileBrowserProps) {
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [root, setRoot] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadFiles = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.getSessionFiles(sessionId);
      setFiles(data.files);
      setRoot(data.root);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load files');
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    loadFiles();
  }, [loadFiles]);

  // Close on Escape
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [onClose]);

  const folderName = root.split('/').filter(Boolean).pop() || 'Project';

  return (
    <>
      {/* Backdrop */}
      <div className="fixed inset-0 bg-black/50 z-40" onClick={onClose} />

      {/* Sheet */}
      <div className="fixed inset-x-0 bottom-0 z-50 max-h-[80vh] flex flex-col bg-background border-t border-border rounded-t-lg sheet-slide-up">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4 text-primary shrink-0">
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
            </svg>
            <span className="text-sm font-medium text-text truncate">{folderName}</span>
            <span className="text-xs text-text-muted truncate hidden sm:inline">{root}</span>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={loadFiles}
              className="text-xs text-text-muted hover:text-primary px-1"
              aria-label="Refresh"
            >
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-3.5 h-3.5">
                <polyline points="23 4 23 10 17 10" />
                <polyline points="1 20 1 14 7 14" />
                <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
              </svg>
            </button>
            <button
              onClick={onClose}
              className="text-text-muted hover:text-text px-1"
              aria-label="Close"
            >
              &times;
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-2 py-2">
          {loading && (
            <div className="flex items-center justify-center py-8">
              <svg className="w-5 h-5 animate-spin text-primary" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
            </div>
          )}

          {error && (
            <div className="text-center py-8">
              <p className="text-status-error text-sm">{error}</p>
            </div>
          )}

          {!loading && !error && files.length === 0 && (
            <div className="text-center py-8">
              <p className="text-text-muted text-sm">Empty folder</p>
            </div>
          )}

          {!loading && !error && files.length > 0 && (
            <div className="space-y-px">
              {files.map((entry) => (
                <FileNode key={entry.path} entry={entry} depth={0} sessionId={sessionId} />
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  );
}

function FileNode({ entry, depth, sessionId }: { entry: FileEntry; depth: number; sessionId: string }) {
  const [expanded, setExpanded] = useState(depth < 1);

  const paddingLeft = depth * 16 + 8;

  if (entry.is_dir) {
    const hasChildren = entry.children && entry.children.length > 0;
    return (
      <div>
        <button
          onClick={() => setExpanded(!expanded)}
          className="w-full flex items-center gap-1.5 py-1 px-2 rounded hover:bg-surface text-left group"
          style={{ paddingLeft }}
        >
          {/* Chevron */}
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={`w-3 h-3 text-text-muted shrink-0 transition-transform ${expanded ? 'rotate-90' : ''}`}
          >
            <polyline points="9 18 15 12 9 6" />
          </svg>
          {/* Folder icon */}
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-3.5 h-3.5 text-primary shrink-0">
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
          </svg>
          <span className="text-xs text-text truncate">{entry.name}</span>
          {hasChildren && (
            <span className="text-[10px] text-text-muted ml-auto shrink-0">{entry.children!.length}</span>
          )}
        </button>
        {expanded && entry.children && (
          <div>
            {entry.children.map((child) => (
              <FileNode key={child.path} entry={child} depth={depth + 1} sessionId={sessionId} />
            ))}
          </div>
        )}
      </div>
    );
  }

  const downloadUrl = `/api/sessions/${encodeURIComponent(sessionId)}/download?path=${encodeURIComponent(entry.path)}`;

  return (
    <div
      className="flex items-center gap-1.5 py-1 px-2 rounded hover:bg-surface group"
      style={{ paddingLeft: paddingLeft + 12 + 6 }}
    >
      {/* File icon */}
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-3.5 h-3.5 text-text-muted shrink-0">
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
        <polyline points="14 2 14 8 20 8" />
      </svg>
      <span className="text-xs text-text truncate">{entry.name}</span>
      {/* Download button — visible on hover */}
      <a
        href={downloadUrl}
        download={entry.name}
        className="ml-auto shrink-0 p-0.5 rounded text-text-muted hover:text-primary opacity-0 group-hover:opacity-100 transition-opacity"
        aria-label={`Download ${entry.name}`}
        onClick={(e) => e.stopPropagation()}
      >
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-3.5 h-3.5">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
          <polyline points="7 10 12 15 17 10" />
          <line x1="12" y1="15" x2="12" y2="3" />
        </svg>
      </a>
      {entry.size != null && (
        <span className="text-[10px] text-text-muted shrink-0">{formatSize(entry.size)}</span>
      )}
    </div>
  );
}
