import { useState, useEffect, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { Layout } from '../components/Layout';
import { SessionPane } from '../components/SessionPane';
import { useKeyboardShortcuts } from '../hooks/useKeyboardShortcuts';
import { useSessions } from '../hooks/useSessions';
import type { Session } from '../types';

export function MultiSessionPage() {
  const navigate = useNavigate();
  const { sessions, refresh } = useSessions();
  const [selectedIds, setSelectedIds] = useState<string[]>(() => {
    try {
      const saved = localStorage.getItem('woodchuck-multi-sessions');
      return saved ? JSON.parse(saved) : [];
    } catch { return []; }
  });
  const [focusedIndex, setFocusedIndex] = useState(0);
  const [showPicker, setShowPicker] = useState(false);

  // Load sessions on mount
  useEffect(() => { refresh(); }, [refresh]);

  // Persist selection
  useEffect(() => {
    localStorage.setItem('woodchuck-multi-sessions', JSON.stringify(selectedIds));
  }, [selectedIds]);

  // Session name lookup
  const sessionMap = useMemo(() => {
    const map = new Map<string, Session>();
    sessions.forEach(s => map.set(s.id, s));
    return map;
  }, [sessions]);

  // Available sessions (not already selected)
  const availableSessions = useMemo(() =>
    sessions.filter(s => !selectedIds.includes(s.id)),
    [sessions, selectedIds]
  );

  const addSession = useCallback((id: string) => {
    if (selectedIds.length >= 4) return;
    setSelectedIds(prev => [...prev, id]);
    setShowPicker(false);
  }, [selectedIds]);

  const removeSession = useCallback((id: string) => {
    setSelectedIds(prev => prev.filter(sid => sid !== id));
    setFocusedIndex(0);
  }, []);

  // Keyboard shortcuts: Ctrl+1-4 to focus pane, Escape to go back
  const shortcuts = useMemo(() => ({
    'Escape': () => navigate('/'),
    'ctrl+1': () => setFocusedIndex(0),
    'ctrl+2': () => { if (selectedIds.length > 1) setFocusedIndex(1); },
    'ctrl+3': () => { if (selectedIds.length > 2) setFocusedIndex(2); },
    'ctrl+4': () => { if (selectedIds.length > 3) setFocusedIndex(3); },
  }), [navigate, selectedIds.length]);

  useKeyboardShortcuts(shortcuts);

  // Grid layout class based on count
  const gridClass = selectedIds.length <= 1
    ? 'grid-cols-1 grid-rows-1'
    : selectedIds.length === 2
      ? 'grid-cols-2 grid-rows-1'
      : 'grid-cols-2 grid-rows-2';

  const headerActions = (
    <div className="flex items-center gap-1">
      <button
        onClick={() => setShowPicker(prev => !prev)}
        disabled={selectedIds.length >= 4}
        className="text-xs font-medium text-primary disabled:opacity-30 px-2 py-1"
      >
        + Add
      </button>
      <button
        onClick={() => navigate('/settings')}
        className="p-2 touch-target btn-active rounded-sm hover:bg-surface-alt text-text-muted hover:text-text"
        aria-label="Settings"
        title="Settings"
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
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
      </button>
    </div>
  );

  return (
    <Layout title={`Multi (${selectedIds.length}/4)`} showBack rightAction={headerActions}>
      <div className="flex flex-col flex-1 min-h-0 overflow-hidden relative">
        {/* Session picker dropdown */}
        {showPicker && (
          <div className="absolute top-0 right-0 z-40 w-64 max-h-80 overflow-auto bg-surface border border-border rounded shadow-lg m-2">
            {availableSessions.length === 0 ? (
              <p className="text-xs text-text-muted p-3">No more sessions available</p>
            ) : (
              availableSessions.map(s => {
                const folderName = s.folder?.split('/').filter(Boolean).pop();
                return (
                  <button
                    key={s.id}
                    onClick={() => addSession(s.id)}
                    className="w-full text-left px-3 py-2 text-xs text-text hover:bg-surface-alt border-b border-border/50 last:border-0"
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-medium truncate">{s.name || s.id}</span>
                      <span className="text-text-muted ml-2 shrink-0">{s.status}</span>
                    </div>
                    {folderName && (
                      <div className="text-[10px] text-text-muted mt-0.5 truncate">{folderName}</div>
                    )}
                  </button>
                );
              })
            )}
          </div>
        )}

        {/* Empty state */}
        {selectedIds.length === 0 && (
          <div className="flex-1 flex items-center justify-center">
            <div className="text-center">
              <p className="text-text-muted text-sm mb-3">No sessions selected</p>
              <button
                onClick={() => setShowPicker(true)}
                className="text-sm font-medium text-primary px-4 py-2 border border-primary rounded"
              >
                Add a session
              </button>
            </div>
          </div>
        )}

        {/* Session grid */}
        {selectedIds.length > 0 && (
          <div className={`flex-1 min-h-0 grid gap-1 p-1 ${gridClass}`}>
            {selectedIds.map((id, i) => (
              <SessionPane
                key={id}
                sessionId={id}
                sessionName={sessionMap.get(id)?.name || id}
                focused={i === focusedIndex}
                onFocus={() => setFocusedIndex(i)}
                onRemove={() => removeSession(id)}
              />
            ))}
          </div>
        )}

        {/* Shortcut hint */}
        {selectedIds.length > 1 && (
          <div className="text-center py-0.5 text-[10px] text-text-muted shrink-0">
            Ctrl+1-{selectedIds.length} to switch panes
          </div>
        )}
      </div>
    </Layout>
  );
}
