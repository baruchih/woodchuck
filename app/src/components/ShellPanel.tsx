import { useState, useEffect, useCallback } from 'react';
import { XtermTerminal } from './XtermTerminal';
import { useSessionOutput } from '../hooks/useSessionOutput';
import { useTerminalFontSize } from '../hooks/useTerminalFontSize';
import { useWS } from '../context/WebSocketContext';
import { api } from '../api/client';

interface ShellPanelProps {
  sessionId: string;
  onClose: () => void;
}

export function ShellPanel({ sessionId, onClose }: ShellPanelProps) {
  const [shellId, setShellId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Open shell on mount
  useEffect(() => {
    let cancelled = false;
    api.openShell(sessionId)
      .then((data) => {
        if (!cancelled) {
          setShellId(data.shell_id);
          setLoading(false);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to open shell');
          setLoading(false);
        }
      });

    return () => { cancelled = true; };
  }, [sessionId]);

  // Close shell on unmount
  useEffect(() => {
    return () => {
      api.closeShell(sessionId).catch(() => {});
    };
  }, [sessionId]);

  const handleClose = useCallback(() => {
    api.closeShell(sessionId).catch(() => {});
    onClose();
  }, [sessionId, onClose]);

  if (loading) {
    return (
      <div className="border-t border-border bg-background shrink-0 h-48 flex items-center justify-center">
        <svg className="w-5 h-5 animate-spin text-primary" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
      </div>
    );
  }

  if (error || !shellId) {
    return (
      <div className="border-t border-border bg-background shrink-0 p-3">
        <p className="text-status-error text-xs">{error || 'Failed to open shell'}</p>
        <button onClick={onClose} className="text-xs text-primary mt-1">Close</button>
      </div>
    );
  }

  return (
    <div className="border-t-2 border-primary shrink-0 flex flex-col" style={{ height: '40%', minHeight: '150px' }}>
      {/* Shell header */}
      <div className="flex items-center justify-between px-2 py-1 bg-surface border-b border-border shrink-0">
        <span className="text-xs font-medium text-primary">Shell</span>
        <button
          onClick={handleClose}
          className="text-xs text-text-muted hover:text-status-error px-1"
        >
          &times;
        </button>
      </div>
      {/* Shell terminal */}
      <div className="flex-1 min-h-0 overflow-hidden">
        <ShellTerminal shellId={shellId} />
      </div>
    </div>
  );
}

/** Inner component that subscribes to the shell tmux session */
function ShellTerminal({ shellId }: { shellId: string }) {
  const { sendRawInput, resize } = useWS();
  const { content } = useSessionOutput({ sessionId: shellId });
  const { fontSize } = useTerminalFontSize();

  const handleInput = useCallback((data: string) => {
    sendRawInput(shellId, data);
  }, [shellId, sendRawInput]);

  const handleResize = useCallback((cols: number, rows: number) => {
    resize(shellId, cols, rows);
  }, [shellId, resize]);

  return (
    <XtermTerminal
      sessionId={shellId}
      content={content}
      fontSize={fontSize}
      onInput={handleInput}
      onResize={handleResize}
      onZoomIn={() => {}}
      onZoomOut={() => {}}
    />
  );
}
