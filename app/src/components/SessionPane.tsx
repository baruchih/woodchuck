import { useState, useCallback, useRef, useEffect } from 'react';
import { XtermTerminal } from './XtermTerminal';
import { SessionInfoSheet } from './SessionInfoSheet';
import { SlashCommandMenu, useSlashCommandState } from './SlashCommandMenu';
import { UploadStatus, useUploadStatus } from './UploadStatus';
import { FileBrowser } from './FileBrowser';
import { useSessionOutput } from '../hooks/useSessionOutput';
import { useTerminalFontSize } from '../hooks/useTerminalFontSize';
import { useCommands } from '../hooks/useCommands';
import { useSessions } from '../hooks/useSessions';
import { useWS } from '../context/WebSocketContext';
import type { Session, Command } from '../types';

interface SessionPaneProps {
  sessionId: string;
  sessionName: string;
  focused: boolean;
  onFocus: () => void;
  onRemove: () => void;
}

export function SessionPane({ sessionId, sessionName, focused, onFocus, onRemove }: SessionPaneProps) {
  const { sendInput, uploadFiles, getSession, deleteSession, renameSession, moveToProject } = useSessions();
  const { resize, sendRawInput } = useWS();
  const { content, needsAttention, triggerFastPoll, notifySentText, forceRefresh } = useSessionOutput({ sessionId });
  const { fontSize, zoomIn, zoomOut } = useTerminalFontSize();
  const [inputText, setInputText] = useState('');
  const [sending, setSending] = useState(false);
  const [slashSelectedIndex, setSlashSelectedIndex] = useState(0);
  const { commands } = useCommands(sessionId);
  const { showMenu: showSlashMenu, filteredCommands } = useSlashCommandState(inputText, commands);
  const { uploadStatus, setUploading, setUploadProgress, setUploadResult } = useUploadStatus();
  const [showFileBrowser, setShowFileBrowser] = useState(false);
  const [showInfoSheet, setShowInfoSheet] = useState(false);
  const [infoSession, setInfoSession] = useState<Session | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const filesInputRef = useRef<HTMLInputElement>(null);

  const handleShowInfo = useCallback(async () => {
    try {
      const data = await getSession(sessionId);
      setInfoSession(data.session);
      setShowInfoSheet(true);
    } catch (err) {
      console.error('Failed to load session info:', err);
    }
  }, [sessionId, getSession]);

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

  const handleSlashSelect = useCallback((command: Command) => {
    const newText = command.name.startsWith('/') ? `${command.name} ` : `/${command.name} `;
    setInputText(newText);
    setSlashSelectedIndex(0);
    textareaRef.current?.focus();
  }, []);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (showSlashMenu && filteredCommands.length > 0) {
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSlashSelectedIndex(prev => prev <= 0 ? filteredCommands.length - 1 : prev - 1);
        return;
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSlashSelectedIndex(prev => prev >= filteredCommands.length - 1 ? 0 : prev + 1);
        return;
      }
      if (e.key === 'Tab') {
        e.preventDefault();
        const cmd = filteredCommands[slashSelectedIndex];
        if (cmd) handleSlashSelect(cmd);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setInputText('');
        setSlashSelectedIndex(0);
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }, [handleSend, showSlashMenu, filteredCommands, slashSelectedIndex, handleSlashSelect]);

  const handleSendKey = useCallback(async (key: string) => {
    try {
      await sendInput(sessionId, key);
      triggerFastPoll();
    } catch (err) {
      console.error('Failed to send key:', err);
    }
  }, [sessionId, sendInput, triggerFastPoll]);

  const handleRefresh = useCallback(() => {
    setRefreshKey((k) => k + 1);
    forceRefresh();
  }, [forceRefresh]);

  const handleUploadFiles = useCallback(() => {
    filesInputRef.current?.click();
  }, []);

  const handleFilesSelected = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0 || uploadStatus.uploading) return;

    setUploading(true);
    try {
      const paths = await uploadFiles(sessionId, files, setUploadProgress);
      const msg = paths.length === 1
        ? `I uploaded a file to the session uploads folder: ${paths[0]}`
        : `I uploaded ${paths.length} files to the session uploads folder: ${paths.join(' ')}`;
      await sendInput(sessionId, msg);
      triggerFastPoll();
      notifySentText(`[uploaded ${paths.length} file${paths.length > 1 ? 's' : ''}]`);
      setUploadResult('success', `Uploaded ${paths.length} file${paths.length > 1 ? 's' : ''}`);
    } catch (err) {
      console.error('Failed to upload files:', err);
      setUploadResult('error', 'Upload failed');
    } finally {
      if (filesInputRef.current) filesInputRef.current.value = '';
    }
  }, [sessionId, uploadStatus.uploading, uploadFiles, sendInput, triggerFastPoll, notifySentText, setUploading, setUploadProgress, setUploadResult]);

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
          <button onClick={(e) => { e.stopPropagation(); handleShowInfo(); }} className="text-[10px] text-text-muted px-1 hover:text-primary" title="Session info" aria-label="Session info">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-3 h-3">
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="16" x2="12" y2="12" />
              <line x1="12" y1="8" x2="12.01" y2="8" />
            </svg>
          </button>
          <button onClick={(e) => { e.stopPropagation(); setShowFileBrowser(true); }} className="text-[10px] text-text-muted px-1 hover:text-primary" title="Browse files" aria-label="Browse files">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-3 h-3">
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
            </svg>
          </button>
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
          refreshKey={refreshKey}
        />
      </div>

      {/* Upload status */}
      <UploadStatus state={uploadStatus} compact />

      {/* Action toolbar */}
      <div className="flex items-center gap-0.5 px-1.5 py-0.5 bg-surface border-t border-border/50 overflow-x-auto shrink-0">
        <PaneAction label="Enter" onClick={() => handleSendKey('Enter')} />
        <PaneAction label="Esc" onClick={() => handleSendKey('Escape')} />
        <PaneAction label="C-b" onClick={() => handleSendKey('C-b')} />
        <PaneAction label="Tab" onClick={() => handleSendKey('Tab')} />
        <PaneAction label="Dir" onClick={() => setShowFileBrowser(true)} />
        <PaneAction label="Ref" onClick={handleRefresh} />
      </div>

      {/* Compact input bar */}
      <div className="relative flex items-start gap-1 px-1.5 py-1 bg-surface border-t border-border shrink-0">
        <SlashCommandMenu
          open={showSlashMenu}
          commands={filteredCommands}
          selectedIndex={slashSelectedIndex}
          onSelect={handleSlashSelect}
          onClose={() => { setInputText(''); setSlashSelectedIndex(0); }}
        />
        <button
          onClick={(e) => { e.stopPropagation(); handleUploadFiles(); }}
          disabled={uploadStatus.uploading}
          className="text-text-muted hover:text-primary disabled:opacity-30 px-0.5 py-0.5 mt-0.5 shrink-0"
          aria-label="Upload files"
          title="Upload files"
        >
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-3.5 h-3.5">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <polyline points="14 2 14 8 20 8" />
            <line x1="12" y1="18" x2="12" y2="12" />
            <line x1="9" y1="15" x2="12" y2="12" />
            <line x1="15" y1="15" x2="12" y2="12" />
          </svg>
        </button>
        <textarea
          ref={textareaRef}
          value={inputText}
          onChange={(e) => { setInputText(e.target.value); setSlashSelectedIndex(0); }}
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
      {/* Hidden file input */}
      <input
        ref={filesInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={handleFilesSelected}
      />
      {/* File Browser */}
      {showFileBrowser && (
        <FileBrowser
          sessionId={sessionId}
          onClose={() => setShowFileBrowser(false)}
        />
      )}
      {/* Session Info Sheet */}
      {showInfoSheet && (
        <SessionInfoSheet
          session={infoSession}
          content={content}
          onClose={() => setShowInfoSheet(false)}
          onDelete={(id) => { deleteSession(id); onRemove(); }}
          onRename={renameSession}
          onMoveToProject={moveToProject}
        />
      )}
    </div>
  );
}

// Compact action button for pane toolbar
function PaneAction({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      className="px-1.5 py-0.5 rounded border border-border text-[9px] font-bold uppercase tracking-wide text-text-muted shrink-0 hover:text-text hover:border-text-muted"
    >
      {label}
    </button>
  );
}
