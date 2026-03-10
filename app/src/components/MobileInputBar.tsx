import { useState, useRef, useCallback } from 'react';

interface MobileInputBarProps {
  onSend: (text: string) => void;
  onUploadImage: () => void;
  sending?: boolean;
}

export function MobileInputBar({ onSend, onUploadImage, sending }: MobileInputBarProps) {
  const [text, setText] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const handleSend = useCallback(() => {
    const trimmed = text.trim();
    if (!trimmed || sending) return;
    onSend(trimmed);
    setText('');
    // Re-focus input for rapid fire
    inputRef.current?.focus();
  }, [text, sending, onSend]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }, [handleSend]);

  return (
    <div className="border-t border-border bg-surface px-2 py-1.5 flex items-center gap-1.5">
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

      {/* Text input */}
      <input
        ref={inputRef}
        type="text"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Type a message..."
        className="flex-1 bg-background border border-border rounded-sm px-3 py-1.5 text-sm text-text placeholder:text-text-muted focus:outline-none focus:border-primary"
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
  );
}
