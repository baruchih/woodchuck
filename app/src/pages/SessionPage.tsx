import { useState, useEffect, useRef, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Layout } from '../components/Layout';
import { FloatingActionButton } from '../components/FloatingActionButton';
import { RadialMenu } from '../components/RadialMenu';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { SlashCommandMenu, useSlashCommandState } from '../components/SlashCommandMenu';
import { SessionInfoSheet } from '../components/SessionInfoSheet';
import { useSessions } from '../hooks/useSessions';
import { useProjects } from '../hooks/useProjects';
import { useTerminal } from '../hooks/useTerminal';
import { useTerminalFontSize } from '../hooks/useTerminalFontSize';
import { useCommands } from '../hooks/useCommands';
import { ansiToHtml } from '../utils/ansi';
import type { Session, Command } from '../types';

export function SessionPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { getSession, deleteSession, sendInput, renameSession, moveToProject } = useSessions();
  const { projects, refresh: refreshProjects } = useProjects();

  const [session, setSession] = useState<Session | null>(null);
  const [inputValue, setInputValue] = useState('');
  const [showKillConfirm, setShowKillConfirm] = useState(false);
  const [showInfoSheet, setShowInfoSheet] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [killing, setKilling] = useState(false);
  const [showScrollButton, setShowScrollButton] = useState(false);
  const [fabCenter, setFabCenter] = useState({ x: 0, y: 0 });
  const [slashMenuSelectedIndex, setSlashMenuSelectedIndex] = useState(0);

  const decodedId = id ? decodeURIComponent(id) : '';

  // Commands for slash autocomplete (session-aware)
  const { commands } = useCommands(decodedId);
  const { showMenu: showSlashMenu, slashFilter, filteredCommands } = useSlashCommandState(inputValue, commands);
  const outputRef = useRef<HTMLPreElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const hiddenInputRef = useRef<HTMLInputElement>(null);

  // Polling hook
  const { content, needsAttention, contextActions, triggerFastPoll, notifySentText } = useTerminal({
    sessionId: decodedId,
  });

  // Terminal font size (zoom)
  const { fontSize, zoomIn, zoomOut, setByPinchScale } = useTerminalFontSize();
  const fontSizeRef = useRef(fontSize);
  fontSizeRef.current = fontSize;

  // Auto-scroll to bottom on content change, but only if user is near the bottom
  // This prevents fighting with manual scroll when user is reading earlier output
  useEffect(() => {
    const pre = outputRef.current;
    if (!pre) return;

    // Check if user is near the bottom BEFORE updating content
    const scrollableHeight = document.documentElement.scrollHeight - window.innerHeight;
    const distanceFromBottom = scrollableHeight - window.scrollY;
    const isNearBottom = distanceFromBottom < 150; // Within 150px of bottom

    pre.innerHTML = ansiToHtml(content) || 'Waiting for output...';

    // Only auto-scroll if user was already near the bottom
    if (isNearBottom) {
      window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'instant' });
    }
  }, [content]);

  // Track window scroll position to show/hide button
  useEffect(() => {
    const updateButtonVisibility = () => {
      const scrollableHeight = document.documentElement.scrollHeight - window.innerHeight;
      const distanceFromBottom = scrollableHeight - window.scrollY;
      // Show button if more than 100px from bottom
      setShowScrollButton(distanceFromBottom > 100);
    };

    // Check on mount
    setTimeout(updateButtonVisibility, 100);

    window.addEventListener('scroll', updateButtonVisibility, { passive: true });
    return () => window.removeEventListener('scroll', updateButtonVisibility);
  }, []);

  // Auto-scroll when font size changes
  useEffect(() => {
    // Scroll to bottom after font size change
    setTimeout(() => {
      window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'instant' });
    }, 0);
  }, [fontSize]);

  // Pinch-to-zoom gesture on the scroll container
  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;

    let pinchStartDist = 0;
    let pinchBaseFontSize = 0;

    function getTouchDistance(t1: Touch, t2: Touch): number {
      const dx = t1.clientX - t2.clientX;
      const dy = t1.clientY - t2.clientY;
      return Math.sqrt(dx * dx + dy * dy);
    }

    const handleTouchStart = (e: TouchEvent) => {
      if (e.touches.length === 2) {
        const dist = getTouchDistance(e.touches[0], e.touches[1]);
        if (dist < 1) return; // Fingers too close — avoid division by zero
        pinchStartDist = dist;
        pinchBaseFontSize = fontSizeRef.current;
      }
    };

    const handleTouchMove = (e: TouchEvent) => {
      if (e.touches.length === 2 && pinchStartDist > 0) {
        e.preventDefault();
        const currentDist = getTouchDistance(e.touches[0], e.touches[1]);
        const scale = currentDist / pinchStartDist;
        setByPinchScale(scale, pinchBaseFontSize);
      }
    };

    const handleTouchEnd = (e: TouchEvent) => {
      if (e.touches.length < 2) {
        pinchStartDist = 0;
        pinchBaseFontSize = 0;
      }
    };

    container.addEventListener('touchstart', handleTouchStart, { passive: true });
    container.addEventListener('touchmove', handleTouchMove, { passive: false });
    container.addEventListener('touchend', handleTouchEnd, { passive: true });

    return () => {
      container.removeEventListener('touchstart', handleTouchStart);
      container.removeEventListener('touchmove', handleTouchMove);
      container.removeEventListener('touchend', handleTouchEnd);
    };
  }, [setByPinchScale]);

  // Global keyboard capture — when no overlay is open, forward
  // printable keystrokes to the hidden input by focusing it on
  // any keydown.  This is more robust than relying on the input
  // keeping focus across menu open/close cycles.
  useEffect(() => {
    const handleGlobalKey = (e: KeyboardEvent) => {
      // Skip if an overlay is open
      if (menuOpen || showKillConfirm) return;
      // Skip if focus is already on the hidden input
      if (document.activeElement === hiddenInputRef.current) return;
      // Skip modifier-only keys and browser shortcuts
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      // Skip non-printable keys except Enter/Backspace/Delete
      if (e.key.length > 1 && !['Enter', 'Backspace', 'Delete'].includes(e.key)) return;

      // Focus the hidden input — the browser will then deliver
      // this same keystroke to the input's own handler.
      hiddenInputRef.current?.focus();
    };

    document.addEventListener('keydown', handleGlobalKey, true);
    return () => document.removeEventListener('keydown', handleGlobalKey, true);
  }, [menuOpen, showKillConfirm]);

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

  // Text send — with sending guard to prevent duplicates
  const handleSendText = useCallback(async () => {
    if (!decodedId || !inputValue.trim() || sending) return;

    const text = inputValue.trim();
    setSending(true);
    try {
      await sendInput(decodedId, text);
      setInputValue('');
      triggerFastPoll();
      notifySentText(text);
    } catch (err) {
      console.error('Failed to send input:', err);
    } finally {
      setSending(false);
    }
  }, [decodedId, inputValue, sending, sendInput, triggerFastPoll, notifySentText]);

  // Key send — NO sending guard for rapid fire
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

  const handleScrollToBottom = useCallback(() => {
    // The page itself is scrolling (html element), so use window.scrollTo
    window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'smooth' });
    setShowScrollButton(false);
  }, []);

  // FAB tap toggles radial menu
  const handleFabTap = useCallback(() => {
    if (menuOpen) {
      setMenuOpen(false);
    } else {
      hiddenInputRef.current?.blur();
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

  const handleTerminalTap = useCallback(() => {
    // Don't focus input if user is selecting text
    if (window.getSelection()?.toString()) return;
    if (!menuOpen) {
      hiddenInputRef.current?.focus();
    }
  }, [menuOpen]);

  // ── Slash command handlers ──

  // Reset selection when filter changes
  useEffect(() => {
    setSlashMenuSelectedIndex(0);
  }, [slashFilter]);

  const handleSlashCommandSelect = useCallback((command: Command) => {
    // Replace input with the selected command (name already includes /)
    setInputValue(command.name + ' ');
    setSlashMenuSelectedIndex(0);
    hiddenInputRef.current?.focus();
  }, []);

  const handleSlashMenuClose = useCallback(() => {
    // Clear input when closing menu without selection
    setInputValue('');
    setSlashMenuSelectedIndex(0);
  }, []);

  const handleSlashMenuNavigate = useCallback((delta: number) => {
    setSlashMenuSelectedIndex((prev) => {
      const len = filteredCommands.length;
      if (len === 0) return 0;
      return (prev + delta + len) % len;
    });
  }, [filteredCommands.length]);

  // ── Display ──

  const title = session?.name || (loading ? 'Loading...' : 'Session');
  const attentionClass = needsAttention ? 'ring-1 ring-status-needs-input' : '';
  const hasTypedText = !!inputValue.trim();

  // Note: We no longer bail out on error - we show the error inline but keep the UI functional

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
      <div className="flex flex-col flex-1 overflow-hidden relative">
        {/* Error banner (if any) */}
        {error && (
          <div className="bg-status-error/20 border-b border-status-error px-3 py-2">
            <p className="text-status-error text-xs">{error}</p>
          </div>
        )}
        {/* Terminal output area — fills all available space */}
        <div className={`flex-1 min-h-0 overflow-hidden ${attentionClass}`}>
          <div
            ref={scrollContainerRef}
            className="h-full overflow-y-scroll bg-background"
            style={{ WebkitOverflowScrolling: 'touch' }}
            onClick={handleTerminalTap}
          >
            <pre
              ref={outputRef}
              className="font-mono text-text whitespace-pre-wrap break-words p-3 leading-[1.4]"
              style={{ fontSize: `${fontSize}px` }}
            />
          </div>
        </div>

        {/* Scroll-to-bottom button - FIXED position so it stays visible during scroll */}
        {showScrollButton && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              handleScrollToBottom();
            }}
            className="fixed right-4 bottom-20 z-50 w-12 h-12 rounded-full border-2 border-primary text-primary flex items-center justify-center shadow-lg bg-surface"
            aria-label="Scroll to bottom"
          >
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="w-6 h-6">
              <path d="M12 5v14M5 12l7 7 7-7" />
            </svg>
          </button>
        )}

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
                {inputValue}
              </span>
              <div className="flex items-center gap-1 shrink-0">
                <button
                  onClick={handleSendText}
                  disabled={sending}
                  className="text-xs font-medium uppercase tracking-wider text-primary disabled:opacity-30 px-2 py-1 btn-active"
                >
                  Send
                </button>
                <button
                  onClick={() => setInputValue('')}
                  className="text-xs text-text-muted px-1 btn-active"
                  aria-label="Clear input"
                >
                  &times;
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Hidden input for keyboard capture */}
        <input
          ref={hiddenInputRef}
          type="text"
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          onKeyDown={(e) => {
            // Handle slash command menu navigation
            if (showSlashMenu && filteredCommands.length > 0) {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                handleSlashMenuNavigate(1);
                return;
              }
              if (e.key === 'ArrowUp') {
                e.preventDefault();
                handleSlashMenuNavigate(-1);
                return;
              }
              if (e.key === 'Enter') {
                e.preventDefault();
                const selected = filteredCommands[slashMenuSelectedIndex];
                if (selected) {
                  handleSlashCommandSelect(selected);
                }
                return;
              }
              if (e.key === 'Escape') {
                e.preventDefault();
                handleSlashMenuClose();
                return;
              }
            }

            // Normal input handling
            if (e.key === 'Enter') {
              e.preventDefault();
              if (inputValue.trim()) {
                handleSendText();
              } else {
                handleSendKey('Enter');
              }
            }
          }}
          className="fixed bottom-0 left-0 opacity-0 w-full h-px -z-10"
          aria-label="Type message to send"
          autoCapitalize="none"
          autoCorrect="off"
          autoComplete="off"
          enterKeyHint="send"
        />
      </div>

      {/* Floating Action Button */}
      <FloatingActionButton
        onTap={handleFabTap}
        onCenterChange={handleFabCenterChange}
        menuOpen={menuOpen}
        needsAttention={needsAttention}
        hasText={hasTypedText}
        hasContextActions={contextActions.length > 0}
      />

      {/* Radial Menu */}
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
      />

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
          onClose={handleCloseInfo}
          onDelete={handleDeleteFromInfo}
          onRename={handleRenameSession}
          onMoveToProject={handleMoveToProject}
        />
      )}
    </Layout>
  );
}
