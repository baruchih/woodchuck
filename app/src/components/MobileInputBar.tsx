import { useState, useRef, useCallback, useEffect } from 'react';
import { SlashCommandMenu, useSlashCommandState } from './SlashCommandMenu';
import type { Command } from '../types';

interface MobileInputBarProps {
  onSend: (text: string) => void;
  onSendKey: (key: string) => void;
  onUploadImage: () => void;
  onUploadFiles: () => void;
  onBrowseFiles: () => void;
  onKillSession: () => void;
  onRefresh: () => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  sending?: boolean;
  commands?: Command[];
}

export function MobileInputBar({
  onSend,
  onSendKey,
  onUploadImage,
  onUploadFiles,
  onBrowseFiles,
  onKillSession,
  onRefresh,
  onZoomIn,
  onZoomOut,
  sending,
  commands = [],
}: MobileInputBarProps) {
  const [text, setText] = useState('');
  const [slashSelectedIndex, setSlashSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const { showMenu, filteredCommands } = useSlashCommandState(text, commands);

  const handleSend = useCallback(() => {
    const trimmed = text.trim();
    if (!trimmed || sending) return;
    onSend(trimmed);
    setText('');
    setSlashSelectedIndex(0);
    inputRef.current?.focus();
  }, [text, sending, onSend]);

  const handleSlashSelect = useCallback((command: Command) => {
    const newText = command.name.startsWith('/') ? `${command.name} ` : `/${command.name} `;
    setText(newText);
    setSlashSelectedIndex(0);
    inputRef.current?.focus();
  }, []);

  // Auto-resize textarea
  useEffect(() => {
    const ta = inputRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, 120)}px`;
  }, [text]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (showMenu && filteredCommands.length > 0) {
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSlashSelectedIndex(prev =>
          prev <= 0 ? filteredCommands.length - 1 : prev - 1
        );
        return;
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSlashSelectedIndex(prev =>
          prev >= filteredCommands.length - 1 ? 0 : prev + 1
        );
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
        setText('');
        setSlashSelectedIndex(0);
        return;
      }
    }
    // On mobile: Enter inserts newline, user taps Send button.
    // On desktop: Enter sends, Shift+Enter inserts newline.
    const isMobile = 'ontouchstart' in window && window.innerWidth < 768;
    if (e.key === 'Enter' && !isMobile && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }, [handleSend, showMenu, filteredCommands, slashSelectedIndex, handleSlashSelect]);

  return (
    <div className="border-t border-border bg-surface shrink-0">
      {/* Quick action toolbar */}
      <div className="flex items-center gap-1 px-2 py-1 border-b border-border/50 overflow-x-auto">
        <ActionButton label="Enter" onClick={() => onSendKey('Enter')} />
        <ActionButton label="Esc" onClick={() => onSendKey('Escape')} />
        <ActionButton label="C-b" onClick={() => onSendKey('C-b')} />
        <ActionButton label="Tab" onClick={() => onSendKey('Tab')} />
        <ActionButton label="A+" onClick={onZoomIn} />
        <ActionButton label="A-" onClick={onZoomOut} />
        <ActionButton label="Dir" onClick={onBrowseFiles} />
        <ActionButton label="Ref" onClick={onRefresh} />
        <ActionButton label="Kill" onClick={onKillSession} variant="danger" />
      </div>

      {/* Text input row */}
      <div className="relative px-2 py-1.5 flex items-center gap-1.5">
        {/* Slash command autocomplete menu */}
        <SlashCommandMenu
          open={showMenu}
          commands={filteredCommands}
          selectedIndex={slashSelectedIndex}
          onSelect={handleSlashSelect}
          onClose={() => { setText(''); setSlashSelectedIndex(0); }}
        />
        {/* Image upload button */}
        <button
          type="button"
          onClick={onUploadImage}
          className="p-2 rounded-sm text-text-muted hover:text-primary btn-active shrink-0"
          aria-label="Upload image"
        >
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5">
            <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
            <circle cx="8.5" cy="8.5" r="1.5" />
            <polyline points="21 15 16 10 5 21" />
          </svg>
        </button>
        {/* File upload button */}
        <button
          type="button"
          onClick={onUploadFiles}
          className="p-2 rounded-sm text-text-muted hover:text-primary btn-active shrink-0"
          aria-label="Upload files"
        >
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <polyline points="14 2 14 8 20 8" />
            <line x1="12" y1="18" x2="12" y2="12" />
            <line x1="9" y1="15" x2="12" y2="12" />
            <line x1="15" y1="15" x2="12" y2="12" />
          </svg>
        </button>

        {/* Text input */}
        <textarea
          ref={inputRef}
          value={text}
          onChange={(e) => { setText(e.target.value); setSlashSelectedIndex(0); }}
          onKeyDown={handleKeyDown}
          placeholder="Type a message..."
          rows={1}
          className="flex-1 bg-background border border-border rounded-sm px-3 py-1.5 text-sm text-text placeholder:text-text-muted focus:outline-none focus:border-primary resize-none overflow-hidden"
          autoComplete="off"
          autoCorrect="on"
        />

        {/* Send button */}
        <button
          type="button"
          onClick={handleSend}
          disabled={!text.trim() || sending}
          className="p-2 rounded-sm text-primary disabled:opacity-30 btn-active shrink-0"
          aria-label="Send"
        >
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5">
            <line x1="22" y1="2" x2="11" y2="13" />
            <polygon points="22 2 15 22 11 13 2 9 22 2" />
          </svg>
        </button>
      </div>
    </div>
  );
}

// Small action button for the toolbar
function ActionButton({
  label,
  onClick,
  variant = 'default',
}: {
  label: string;
  onClick: () => void;
  variant?: 'default' | 'danger';
}) {
  const colorClass = variant === 'danger'
    ? 'text-status-error border-status-error/40'
    : 'text-text-muted border-border';

  return (
    <button
      type="button"
      onClick={onClick}
      className={`px-2.5 py-1 rounded border text-[11px] font-bold uppercase tracking-wide shrink-0 btn-active ${colorClass}`}
    >
      {label}
    </button>
  );
}
