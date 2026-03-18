import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useKeyboardShortcuts } from '../hooks/useKeyboardShortcuts';
import { ShortcutsHelp } from '../components/ShortcutsHelp';
import { Layout } from '../components/Layout';
import { FloatingActionButton } from '../components/FloatingActionButton';
import { RadialMenu } from '../components/RadialMenu';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { SlashCommandMenu, useSlashCommandState } from '../components/SlashCommandMenu';
import { SessionInfoSheet } from '../components/SessionInfoSheet';
import { XtermTerminal } from '../components/XtermTerminal';
import { MobileInputBar } from '../components/MobileInputBar';
import { UploadStatus, useUploadStatus } from '../components/UploadStatus';
import { FileBrowser } from '../components/FileBrowser';
import { useSessions } from '../hooks/useSessions';
import { useProjects } from '../hooks/useProjects';
import { useTerminal } from '../hooks/useTerminal';
import { useTerminalFontSize } from '../hooks/useTerminalFontSize';
import { useCommands } from '../hooks/useCommands';
import { useWS } from '../context/WebSocketContext';
import type { Session, Command } from '../types';

export function SessionPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { getSession, deleteSession, sendInput, uploadImage, uploadFiles, renameSession, moveToProject } = useSessions();
  const { projects, refresh: refreshProjects } = useProjects();
  const { resize, sendRawInput } = useWS();

  const [session, setSession] = useState<Session | null>(null);
  const [inputBuffer, setInputBuffer] = useState('');
  const [showKillConfirm, setShowKillConfirm] = useState(false);
  const [showInfoSheet, setShowInfoSheet] = useState(false);
  const [showFileBrowser, setShowFileBrowser] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [killing, setKilling] = useState(false);
  const [fabCenter, setFabCenter] = useState({ x: 0, y: 0 });
  const [slashMenuSelectedIndex, setSlashMenuSelectedIndex] = useState(0);

  const decodedId = id ? decodeURIComponent(id) : '';

  // Commands for slash autocomplete (session-aware)
  const { commands } = useCommands(decodedId);
  const { showMenu: showSlashMenu, slashFilter, filteredCommands } = useSlashCommandState(inputBuffer, commands);

  // Ref to track if we're in slash mode (typing a slash command)
  const slashModeRef = useRef(false);

  // Hidden file inputs for uploads
  const fileInputRef = useRef<HTMLInputElement>(null);
  const filesInputRef = useRef<HTMLInputElement>(null);
  const { uploadStatus, setUploading, setUploadProgress, setUploadResult } = useUploadStatus();

  // Detect mobile (touch device with narrow screen)
  const isMobile = 'ontouchstart' in window && window.innerWidth < 768;

  const [refreshKey, setRefreshKey] = useState(0);

  // Polling hook
  const { content, needsAttention, contextActions, triggerFastPoll, notifySentText, forceRefresh } = useTerminal({
    sessionId: decodedId,
  });

  // Terminal font size (zoom)
  const { fontSize, zoomIn, zoomOut } = useTerminalFontSize();

  // Load session metadata and projects
  useEffect(() => {
    if (!decodedId) return;

    const loadSession = async () => {
      setLoading(true);
      setError(null);
      try {
        const data = await getSession(decodedId);
        setSession(data.session);
        // Also load projects for the info sheet
        await refreshProjects();
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to load session';
        setError(message);
        if (message.toLowerCase().includes('not found')) {
          setTimeout(() => navigate('/'), 2000);
        }
      } finally {
        setLoading(false);
      }
    };

    loadSession();
  }, [decodedId, getSession, navigate, refreshProjects]);

  // ── Input handlers ──

  // Handle raw terminal input from xterm
  const handleTerminalInput = useCallback(async (data: string) => {
    if (!decodedId || menuOpen) return;

    // Check if starting a slash command
    if (data === '/' && inputBuffer === '') {
      setInputBuffer('/');
      slashModeRef.current = true;
      return;
    }

    // If in slash mode, handle input locally (buffered)
    if (slashModeRef.current) {
      if (data === '\r' || data === '\n') {
        // Enter: send the slash command
        if (inputBuffer.trim()) {
          setSending(true);
          try {
            await sendInput(decodedId, inputBuffer.trim());
            triggerFastPoll();
            notifySentText(inputBuffer.trim());
          } catch (err) {
            console.error('Failed to send input:', err);
          } finally {
            setSending(false);
          }
        }
        setInputBuffer('');
        slashModeRef.current = false;
        return;
      }

      if (data === '\x7f' || data === '\b') {
        if (inputBuffer.length <= 1) {
          setInputBuffer('');
          slashModeRef.current = false;
        } else {
          setInputBuffer(prev => prev.slice(0, -1));
        }
        return;
      }

      if (data === '\x1b') {
        setInputBuffer('');
        slashModeRef.current = false;
        return;
      }

      if (data === '\x1b[A') {
        setSlashMenuSelectedIndex((prev) => {
          const len = filteredCommands.length;
          if (len === 0) return 0;
          return (prev - 1 + len) % len;
        });
        return;
      }

      if (data === '\x1b[B') {
        setSlashMenuSelectedIndex((prev) => {
          const len = filteredCommands.length;
          if (len === 0) return 0;
          return (prev + 1) % len;
        });
        return;
      }

      if (data === '\t') {
        const selected = filteredCommands[slashMenuSelectedIndex];
        if (selected) {
          setInputBuffer(selected.name + ' ');
          setSlashMenuSelectedIndex(0);
        }
        return;
      }

      // Regular character: append to slash buffer
      if (data.length === 1 && data >= ' ') {
        setInputBuffer(prev => prev + data);
        return;
      }

      return;
    }

    // Not in slash mode: send raw xterm data directly to tmux
    // The shell/process in tmux handles echoing, line editing, and buffering
    sendRawInput(decodedId, data);
    triggerFastPoll();
  }, [decodedId, menuOpen, inputBuffer, filteredCommands, slashMenuSelectedIndex, sendInput, sendRawInput, triggerFastPoll, notifySentText]);

  // Handle resize from xterm
  const handleTerminalResize = useCallback((cols: number, rows: number) => {
    if (!decodedId) return;
    resize(decodedId, cols, rows);
  }, [decodedId, resize]);

  // Key send from radial menu — NO sending guard for rapid fire
  const handleSendKey = useCallback(async (key: string) => {
    if (!decodedId) return;

    try {
      await sendInput(decodedId, key);
      triggerFastPoll();
    } catch (err) {
      console.error('Failed to send key:', err);
    }
  }, [decodedId, sendInput, triggerFastPoll]);

  const handleKillSession = useCallback(async () => {
    if (!decodedId || killing) return;

    setKilling(true);
    try {
      await deleteSession(decodedId);
      navigate('/');
    } catch (err) {
      console.error('Failed to kill session:', err);
      setShowKillConfirm(false);
    } finally {
      setKilling(false);
    }
  }, [decodedId, killing, deleteSession, navigate]);

  // FAB tap toggles radial menu
  const handleFabTap = useCallback(() => {
    if (menuOpen) {
      setMenuOpen(false);
    } else {
      setMenuOpen(true);
    }
  }, [menuOpen]);

  // Track FAB center for radial menu positioning
  const handleFabCenterChange = useCallback((cx: number, cy: number) => {
    setFabCenter({ x: cx, y: cy });
  }, []);

  const handleMenuClose = useCallback(() => {
    setMenuOpen(false);
  }, []);

  const handleKillFromMenu = useCallback(() => {
    setMenuOpen(false);
    setShowKillConfirm(true);
  }, []);

  // Mobile input bar: send text as input
  const handleMobileSend = useCallback(async (text: string) => {
    if (!decodedId || sending) return;
    setSending(true);
    try {
      await sendInput(decodedId, text);
      triggerFastPoll();
      notifySentText(text);
    } catch (err) {
      console.error('Failed to send input:', err);
    } finally {
      setSending(false);
    }
  }, [decodedId, sending, sendInput, triggerFastPoll, notifySentText]);

  // Image upload: open file picker
  const handleUploadImage = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  // Image upload: handle file selection (supports multiple)
  const handleFileSelected = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0 || !decodedId || uploadStatus.uploading) return;

    setUploading(true);
    try {
      const paths: string[] = [];
      const fileArr = Array.from(files);
      for (let i = 0; i < fileArr.length; i++) {
        const path = await uploadImage(decodedId, fileArr[i], (pct) => {
          // Scale progress across multiple files
          const filePct = Math.round(((i + pct / 100) / fileArr.length) * 100);
          setUploadProgress(filePct);
        });
        paths.push(path);
      }
      // Send all file paths as input so Claude Code can read them
      const msg = paths.length === 1
        ? `see this image: ${paths[0]}`
        : `see these images: ${paths.join(' ')}`;
      await sendInput(decodedId, msg);
      triggerFastPoll();
      notifySentText(`[uploaded ${paths.length} image${paths.length > 1 ? 's' : ''}]`);
      setUploadResult('success', `Uploaded ${paths.length} image${paths.length > 1 ? 's' : ''}`);
    } catch (err) {
      console.error('Failed to upload image:', err);
      setUploadResult('error', 'Image upload failed');
    } finally {
      // Reset the input so the same files can be selected again
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }, [decodedId, uploadStatus.uploading, uploadImage, sendInput, triggerFastPoll, notifySentText, setUploading, setUploadProgress, setUploadResult]);

  // File upload: open file picker
  const handleUploadFiles = useCallback(() => {
    filesInputRef.current?.click();
  }, []);

  // File upload: handle file selection
  const handleFilesSelected = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0 || !decodedId || uploadStatus.uploading) return;

    setUploading(true);
    try {
      const paths = await uploadFiles(decodedId, files, setUploadProgress);
      const msg = paths.length === 1
        ? `I uploaded a file to the session uploads folder: ${paths[0]}`
        : `I uploaded ${paths.length} files to the session uploads folder: ${paths.join(' ')}`;
      await sendInput(decodedId, msg);
      triggerFastPoll();
      notifySentText(`[uploaded ${paths.length} file${paths.length > 1 ? 's' : ''}]`);
      setUploadResult('success', `Uploaded ${paths.length} file${paths.length > 1 ? 's' : ''}`);
    } catch (err) {
      console.error('Failed to upload files:', err);
      setUploadResult('error', 'Upload failed');
    } finally {
      if (filesInputRef.current) filesInputRef.current.value = '';
    }
  }, [decodedId, uploadStatus.uploading, uploadFiles, sendInput, triggerFastPoll, notifySentText, setUploading, setUploadProgress, setUploadResult]);

  // Refresh terminal — resets stuck write state and re-fetches content via HTTP
  const handleRefresh = useCallback(() => {
    setRefreshKey((k) => k + 1);
    forceRefresh();
  }, [forceRefresh]);

  const handleShowInfo = useCallback(() => {
    setShowInfoSheet(true);
  }, []);

  const handleCloseInfo = useCallback(() => {
    setShowInfoSheet(false);
  }, []);

  const handleDeleteFromInfo = useCallback(async (sessionId: string) => {
    try {
      await deleteSession(sessionId);
      navigate('/');
    } catch (err) {
      console.error('Failed to delete session:', err);
    }
  }, [deleteSession, navigate]);

  const handleRenameSession = useCallback(async (sessionId: string, newName: string) => {
    try {
      await renameSession(sessionId, newName);
      setSession((prev) => prev ? { ...prev, name: newName } : null);
    } catch (err) {
      console.error('Failed to rename session:', err);
    }
  }, [renameSession]);

  const handleMoveToProject = useCallback(async (sessionId: string, projectId: string | null) => {
    try {
      await moveToProject(sessionId, projectId);
      setSession((prev) => prev ? { ...prev, project_id: projectId ?? undefined } : null);
    } catch (err) {
      console.error('Failed to move session to project:', err);
    }
  }, [moveToProject]);

  // ── Keyboard shortcuts ──
  const [showShortcuts, setShowShortcuts] = useState(false);

  const globalShortcuts = useMemo(() => ({
    'Escape': () => navigate('/'),
    '?': () => setShowShortcuts((prev) => !prev),
  }), [navigate]);

  useKeyboardShortcuts(globalShortcuts);

  // ── Slash command handlers ──

  // Reset selection when filter changes
  useEffect(() => {
    setSlashMenuSelectedIndex(0);
  }, [slashFilter]);

  const handleSlashCommandSelect = useCallback((command: Command) => {
    // Replace buffer with the selected command
    setInputBuffer(command.name + ' ');
    setSlashMenuSelectedIndex(0);
  }, []);

  const handleSlashMenuClose = useCallback(() => {
    // Clear buffer when closing menu without selection
    setInputBuffer('');
    slashModeRef.current = false;
    setSlashMenuSelectedIndex(0);
  }, []);

  // ── Display ──

  const title = session?.name || (loading ? 'Loading...' : 'Session');
  const attentionClass = needsAttention ? 'ring-1 ring-status-needs-input' : '';
  const hasTypedText = inputBuffer.trim().length > 0;

  const infoButton = (
    <button
      onClick={handleShowInfo}
      className="p-2 -mr-2 touch-target btn-active rounded-sm hover:bg-surface-alt text-text-muted hover:text-primary"
      aria-label="Session info"
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="w-5 h-5"
      >
        <circle cx="12" cy="12" r="10" />
        <line x1="12" y1="16" x2="12" y2="12" />
        <line x1="12" y1="8" x2="12.01" y2="8" />
      </svg>
    </button>
  );

  return (
    <Layout title={title} showBack rightAction={infoButton}>
      <div className="flex flex-col flex-1 min-h-0 overflow-hidden relative">
        {/* Error banner (if any) */}
        {error && (
          <div className="bg-status-error/20 border-b border-status-error px-3 py-2">
            <p className="text-status-error text-xs">{error}</p>
          </div>
        )}
        {/* Terminal output area — fills all available space */}
        <div className={`flex-1 min-h-0 overflow-hidden ${attentionClass}`}>
          <XtermTerminal
            sessionId={decodedId}
            content={content}
            fontSize={fontSize}
            onInput={handleTerminalInput}
            onResize={handleTerminalResize}
            onZoomIn={zoomIn}
            onZoomOut={zoomOut}
            disableKeyboard
            refreshKey={refreshKey}
          />
        </div>

        {/* Upload status indicator */}
        <UploadStatus state={uploadStatus} />

        {/* Input bar — text input + action toolbar for reliable message sending */}
        <MobileInputBar
          onSend={handleMobileSend}
          onSendKey={handleSendKey}
          onUploadImage={handleUploadImage}
          onUploadFiles={handleUploadFiles}
          onBrowseFiles={() => setShowFileBrowser(true)}
          onKillSession={() => setShowKillConfirm(true)}
          onRefresh={handleRefresh}
          onZoomIn={zoomIn}
          onZoomOut={zoomOut}
          sending={sending}
          commands={commands}
        />

        {/* Typing preview bar with slash command menu */}
        {(hasTypedText || showSlashMenu) && (
          <div className="absolute bottom-0 left-0 right-0 bg-surface/95 border-t border-border px-3 py-2 z-10">
            {/* Slash command dropdown - positioned above the bar */}
            <SlashCommandMenu
              open={showSlashMenu}
              commands={filteredCommands}
              selectedIndex={slashMenuSelectedIndex}
              onSelect={handleSlashCommandSelect}
              onClose={handleSlashMenuClose}
            />

            <div className="flex items-start gap-2">
              <span className="text-primary mt-0.5" style={{ fontSize: `${fontSize}px` }}>$</span>
              <span className="text-text font-mono flex-1 break-words whitespace-pre-wrap" style={{ fontSize: `${fontSize}px` }}>
                {inputBuffer}
              </span>
              <div className="flex items-center gap-1 shrink-0">
                <button
                  onClick={async () => {
                    if (!decodedId || !inputBuffer.trim() || sending) return;
                    setSending(true);
                    try {
                      await sendInput(decodedId, inputBuffer.trim());
                      setInputBuffer('');
                      slashModeRef.current = false;
                      triggerFastPoll();
                      notifySentText(inputBuffer.trim());
                    } catch (err) {
                      console.error('Failed to send input:', err);
                    } finally {
                      setSending(false);
                    }
                  }}
                  disabled={sending}
                  className="text-xs font-medium uppercase tracking-wider text-primary disabled:opacity-30 px-2 py-1 btn-active"
                >
                  Send
                </button>
                <button
                  onClick={() => {
                    setInputBuffer('');
                    slashModeRef.current = false;
                  }}
                  className="text-xs text-text-muted px-1 btn-active"
                  aria-label="Clear input"
                >
                  &times;
                </button>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Floating Action Button — desktop only (mobile uses input bar toolbar) */}
      {!isMobile && (
        <FloatingActionButton
          onTap={handleFabTap}
          onCenterChange={handleFabCenterChange}
          menuOpen={menuOpen}
          needsAttention={needsAttention}
          hasText={hasTypedText}
          hasContextActions={contextActions.length > 0}
        />
      )}

      {/* Radial Menu — desktop only */}
      {!isMobile && (
        <RadialMenu
          open={menuOpen}
          centerX={fabCenter.x}
          centerY={fabCenter.y}
          onClose={handleMenuClose}
          onSendKey={handleSendKey}
          onKillSession={handleKillFromMenu}
          contextActions={contextActions}
          onZoomIn={zoomIn}
          onZoomOut={zoomOut}
          onUploadImage={handleUploadImage}
          onUploadFiles={handleUploadFiles}
          onBrowseFiles={() => setShowFileBrowser(true)}
        />
      )}

      {/* File Browser */}
      {showFileBrowser && (
        <FileBrowser
          sessionId={decodedId}
          onClose={() => setShowFileBrowser(false)}
        />
      )}

      {/* Kill Session Confirm Dialog */}
      <ConfirmDialog
        open={showKillConfirm}
        title="Kill Session"
        message={`Kill "${session?.name || decodedId}"? This cannot be undone.`}
        confirmLabel="Kill"
        onConfirm={handleKillSession}
        onCancel={() => setShowKillConfirm(false)}
      />

      {/* Session Info Sheet */}
      {showInfoSheet && (
        <SessionInfoSheet
          session={session}
          projects={projects}
          content={content}
          onClose={handleCloseInfo}
          onDelete={handleDeleteFromInfo}
          onRename={handleRenameSession}
          onMoveToProject={handleMoveToProject}
        />
      )}

      <ShortcutsHelp
        open={showShortcuts}
        onClose={() => setShowShortcuts(false)}
        shortcuts={[
          { key: 'Escape', description: 'Back to sessions list' },
          { key: '?', description: 'Show/hide this help' },
        ]}
      />

      {/* Hidden file input for image upload */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        multiple
        className="hidden"
        onChange={handleFileSelected}
      />
      {/* Hidden file input for general file upload */}
      <input
        ref={filesInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={handleFilesSelected}
      />
    </Layout>
  );
}
