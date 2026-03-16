import { useState, useEffect, useCallback } from 'react';
import { api } from '../api/client';
import type { FileEntry } from '../types';

interface FileBrowserProps {
  sessionId: string;
  onClose: () => void;
}

// Extensions that can be viewed as text
const VIEWABLE_EXTENSIONS = new Set([
  'txt', 'md', 'markdown', 'rst', 'json', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf',
  'xml', 'html', 'htm', 'css', 'scss', 'less', 'svg',
  'js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs',
  'py', 'rb', 'rs', 'go', 'java', 'kt', 'kts', 'scala', 'c', 'cpp', 'cc', 'h', 'hpp',
  'cs', 'swift', 'm', 'mm', 'zig', 'nim', 'lua', 'pl', 'pm', 'r',
  'sh', 'bash', 'zsh', 'fish', 'ps1', 'bat', 'cmd',
  'sql', 'graphql', 'gql', 'proto',
  'dockerfile', 'makefile', 'cmake',
  'env', 'gitignore', 'gitattributes', 'editorconfig', 'eslintrc', 'prettierrc',
  'lock', 'log', 'csv', 'tsv',
]);

function isViewable(name: string): boolean {
  // Files without extensions like Makefile, Dockerfile, etc.
  const lower = name.toLowerCase();
  if (VIEWABLE_EXTENSIONS.has(lower)) return true;
  const ext = lower.split('.').pop() || '';
  return VIEWABLE_EXTENSIONS.has(ext);
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
  const [viewingFile, setViewingFile] = useState<{ path: string; name: string } | null>(null);

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

  // Close on Escape (only when not viewing a file)
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        if (viewingFile) {
          setViewingFile(null);
        } else {
          onClose();
        }
      }
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [onClose, viewingFile]);

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
                <FileNode
                  key={entry.path}
                  entry={entry}
                  depth={0}
                  sessionId={sessionId}
                  onView={setViewingFile}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      {/* File viewer overlay */}
      {viewingFile && (
        <FileViewer
          sessionId={sessionId}
          path={viewingFile.path}
          name={viewingFile.name}
          onClose={() => setViewingFile(null)}
        />
      )}
    </>
  );
}

function FileNode({
  entry,
  depth,
  sessionId,
  onView,
}: {
  entry: FileEntry;
  depth: number;
  sessionId: string;
  onView: (file: { path: string; name: string }) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [children, setChildren] = useState<FileEntry[] | null>(null);
  const [loading, setLoading] = useState(false);

  const paddingLeft = depth * 16 + 8;

  const handleToggle = useCallback(async () => {
    if (expanded) {
      setExpanded(false);
      return;
    }
    setExpanded(true);
    // Fetch children on first expand
    if (children === null) {
      setLoading(true);
      try {
        const data = await api.getSessionFiles(sessionId, entry.path);
        setChildren(data.files);
      } catch {
        setChildren([]);
      } finally {
        setLoading(false);
      }
    }
  }, [expanded, children, sessionId, entry.path]);

  if (entry.is_dir) {
    return (
      <div>
        <button
          onClick={handleToggle}
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
          {loading && (
            <svg className="w-3 h-3 animate-spin text-text-muted ml-auto shrink-0" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
          )}
        </button>
        {expanded && children && children.length > 0 && (
          <div>
            {children.map((child) => (
              <FileNode key={child.path} entry={child} depth={depth + 1} sessionId={sessionId} onView={onView} />
            ))}
          </div>
        )}
        {expanded && children && children.length === 0 && !loading && (
          <div className="text-[10px] text-text-muted py-1" style={{ paddingLeft: paddingLeft + 24 }}>
            Empty
          </div>
        )}
      </div>
    );
  }

  const downloadUrl = `/api/sessions/${encodeURIComponent(sessionId)}/download?path=${encodeURIComponent(entry.path)}`;
  const canView = isViewable(entry.name) && (entry.size == null || entry.size <= 2 * 1024 * 1024);

  return (
    <div
      className={`flex items-center gap-1.5 py-1 px-2 rounded hover:bg-surface group ${canView ? 'cursor-pointer' : ''}`}
      style={{ paddingLeft: paddingLeft + 12 + 6 }}
      onClick={canView ? () => onView({ path: entry.path, name: entry.name }) : undefined}
    >
      {/* File icon */}
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-3.5 h-3.5 text-text-muted shrink-0">
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
        <polyline points="14 2 14 8 20 8" />
      </svg>
      <span className="text-xs text-text truncate">{entry.name}</span>
      {/* View button for viewable files */}
      {canView && (
        <button
          className="shrink-0 p-0.5 rounded text-text-muted hover:text-primary opacity-0 group-hover:opacity-100 transition-opacity"
          aria-label={`View ${entry.name}`}
          onClick={(e) => { e.stopPropagation(); onView({ path: entry.path, name: entry.name }); }}
        >
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-3.5 h-3.5">
            <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
            <circle cx="12" cy="12" r="3" />
          </svg>
        </button>
      )}
      {/* Download button */}
      <a
        href={downloadUrl}
        download={entry.name}
        className={`shrink-0 p-0.5 rounded text-text-muted hover:text-primary opacity-0 group-hover:opacity-100 transition-opacity ${canView ? '' : 'ml-auto'}`}
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

function FileViewer({
  sessionId,
  path,
  name,
  onClose,
}: {
  sessionId: string;
  path: string;
  name: string;
  onClose: () => void;
}) {
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    api.getFileContent(sessionId, path)
      .then((data) => {
        if (!cancelled) setContent(data.content);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load file');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [sessionId, path]);

  const handleCopyAll = useCallback(async () => {
    if (!content) return;
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback: select all text in the pre element
      const pre = document.getElementById('file-viewer-content');
      if (pre) {
        const range = document.createRange();
        range.selectNodeContents(pre);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
      }
    }
  }, [content]);

  const downloadUrl = `/api/sessions/${encodeURIComponent(sessionId)}/download?path=${encodeURIComponent(path)}`;

  return (
    <div className="fixed inset-0 z-[60] flex flex-col bg-background">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-border shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <button
            onClick={onClose}
            className="text-text-muted hover:text-text shrink-0 p-0.5"
            aria-label="Back"
          >
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4">
              <polyline points="15 18 9 12 15 6" />
            </svg>
          </button>
          <span className="text-sm font-medium text-text truncate">{name}</span>
          <span className="text-[10px] text-text-muted shrink-0">{path}</span>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {/* Copy all button */}
          <button
            onClick={handleCopyAll}
            disabled={!content}
            className="flex items-center gap-1 px-2 py-1 rounded border border-border text-[11px] font-medium text-text-muted hover:text-primary hover:border-primary disabled:opacity-30 transition-colors"
          >
            {copied ? (
              <>
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-3 h-3 text-status-success">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
                Copied
              </>
            ) : (
              <>
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-3 h-3">
                  <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                  <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                </svg>
                Copy all
              </>
            )}
          </button>
          {/* Download */}
          <a
            href={downloadUrl}
            download={name}
            className="flex items-center gap-1 px-2 py-1 rounded border border-border text-[11px] font-medium text-text-muted hover:text-primary hover:border-primary transition-colors"
          >
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-3 h-3">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
            Download
          </a>
        </div>
      </div>

      {/* File content */}
      <div className="flex-1 overflow-auto">
        {loading && (
          <div className="flex items-center justify-center py-12">
            <svg className="w-5 h-5 animate-spin text-primary" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
          </div>
        )}

        {error && (
          <div className="text-center py-12">
            <p className="text-status-error text-sm">{error}</p>
          </div>
        )}

        {!loading && !error && content != null && (
          <pre
            id="file-viewer-content"
            className="p-4 text-xs leading-relaxed text-text font-mono whitespace-pre-wrap break-words select-text"
          >{content}</pre>
        )}
      </div>
    </div>
  );
}
