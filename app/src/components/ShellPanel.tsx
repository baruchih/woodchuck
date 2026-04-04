import { useState, useEffect, useCallback, useRef } from 'react';
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
      {/* Shell input bar */}
      <ShellInput shellId={shellId} />
    </div>
  );
}

/** Terminal display for the shell */
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
      disableKeyboard
    />
  );
}

/** Text input bar for the shell */
function ShellInput({ shellId }: { shellId: string }) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleSend = useCallback(async () => {
    const trimmed = text.trim();
    if (!trimmed || sending) return;
    setSending(true);
    try {
      await api.sendInput(shellId, trimmed);
      setText('');
      inputRef.current?.focus();
    } catch (err) {
      console.error('Failed to send shell input:', err);
    } finally {
      setSending(false);
    }
  }, [text, sending, shellId]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }, [handleSend]);

  return (
    <div className="flex items-center gap-1.5 px-2 py-1.5 bg-surface border-t border-border shrink-0">
      <span className="text-primary text-xs font-mono shrink-0">$</span>
      <input
        ref={inputRef}
        type="text"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Shell command..."
        className="flex-1 bg-background border border-border rounded-sm px-2 py-1 text-xs text-text font-mono placeholder:text-text-muted focus:outline-none focus:border-primary"
        autoComplete="off"
        autoFocus
      />
      <button
        onClick={handleSend}
        disabled={!text.trim() || sending}
        className="text-xs font-medium text-primary disabled:opacity-30 px-2 py-1"
      >
        Run
      </button>
    </div>
  );
}
