import { useState, useCallback, useRef, useEffect } from 'react';
import { XtermTerminal } from './XtermTerminal';
import { useTerminal } from '../hooks/useTerminal';
import { useTerminalFontSize } from '../hooks/useTerminalFontSize';
import { useSessions } from '../hooks/useSessions';
import { useWS } from '../context/WebSocketContext';

interface SessionPaneProps {
  sessionId: string;
  sessionName: string;
  focused: boolean;
  onFocus: () => void;
  onRemove: () => void;
}

export function SessionPane({ sessionId, sessionName, focused, onFocus, onRemove }: SessionPaneProps) {
  const { sendInput } = useSessions();
  const { resize, sendRawInput } = useWS();
  const { content, needsAttention, triggerFastPoll, notifySentText } = useTerminal({ sessionId });
  const { fontSize, zoomIn, zoomOut } = useTerminalFontSize();
  const [inputText, setInputText] = useState('');
  const [sending, setSending] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const handleTerminalInput = useCallback((data: string) => {
    if (!focused) return;
    sendRawInput(sessionId, data);
    triggerFastPoll();
  }, [focused, sessionId, sendRawInput, triggerFastPoll]);

  const handleResize = useCallback((cols: number, rows: number) => {
    resize(sessionId, cols, rows);
  }, [sessionId, resize]);

  const handleSend = useCallback(async () => {
    const trimmed = inputText.trim();
    if (!trimmed || sending) return;
    setSending(true);
    try {
      await sendInput(sessionId, trimmed);
      setInputText('');
      triggerFastPoll();
      notifySentText(trimmed);
    } catch (err) {
      console.error('Failed to send input:', err);
    } finally {
      setSending(false);
    }
  }, [inputText, sending, sessionId, sendInput, triggerFastPoll, notifySentText]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }, [handleSend]);

  // Auto-resize textarea
  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, 120)}px`;
  }, [inputText]);

  const attentionRing = needsAttention ? 'ring-2 ring-status-needs-input' : '';
  const focusRing = focused ? 'ring-2 ring-primary' : '';

  return (
    <div
      className={`flex flex-col min-h-0 overflow-hidden bg-background border border-border rounded ${attentionRing || focusRing}`}
      onClick={onFocus}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-2 py-1 bg-surface border-b border-border shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          {needsAttention && <span className="w-2 h-2 rounded-full bg-status-needs-input shrink-0" />}
          <span className="text-xs font-medium text-text truncate">{sessionName}</span>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <button onClick={(e) => { e.stopPropagation(); zoomOut(); }} className="text-[10px] text-text-muted px-1 hover:text-text">A-</button>
          <button onClick={(e) => { e.stopPropagation(); zoomIn(); }} className="text-[10px] text-text-muted px-1 hover:text-text">A+</button>
          <button onClick={(e) => { e.stopPropagation(); onRemove(); }} className="text-[10px] text-text-muted px-1 hover:text-status-error">&times;</button>
        </div>
      </div>

      {/* Terminal */}
      <div className="flex-1 min-h-0 overflow-hidden">
        <XtermTerminal
          sessionId={sessionId}
          content={content}
          fontSize={fontSize}
          onInput={handleTerminalInput}
          onResize={handleResize}
          onZoomIn={zoomIn}
          onZoomOut={zoomOut}
          disableKeyboard={!focused}
        />
      </div>

      {/* Compact input bar */}
      <div className="flex items-start gap-1 px-1.5 py-1 bg-surface border-t border-border shrink-0">
        <textarea
          ref={textareaRef}
          value={inputText}
          onChange={(e) => setInputText(e.target.value)}
          onKeyDown={handleKeyDown}
          onFocus={onFocus}
          placeholder={focused ? 'Type here...' : 'Click to focus'}
          rows={1}
          className="flex-1 bg-background border border-border rounded px-2 py-0.5 text-xs text-text placeholder:text-text-muted focus:outline-none focus:border-primary resize-none overflow-hidden"
          autoComplete="off"
        />
        <button
          onClick={handleSend}
          disabled={!inputText.trim() || sending}
          className="text-[10px] font-medium text-primary disabled:opacity-30 px-1.5 py-0.5 mt-0.5"
        >
          Send
        </button>
      </div>
    </div>
  );
}
