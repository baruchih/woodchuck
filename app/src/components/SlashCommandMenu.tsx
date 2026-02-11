import { useEffect, useRef, useCallback } from 'react';
import type { Command } from '../types';

interface SlashCommandMenuProps {
  open: boolean;
  commands: Command[];  // Pre-filtered commands from useSlashCommandState
  selectedIndex: number;
  onSelect: (command: Command) => void;
  onClose: () => void;
}

export function SlashCommandMenu({
  open,
  commands,  // Already filtered by useSlashCommandState
  selectedIndex,
  onSelect,
  onClose,
}: SlashCommandMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const selectedRef = useRef<HTMLButtonElement>(null);

  // Scroll selected item into view
  useEffect(() => {
    if (open && selectedRef.current) {
      selectedRef.current.scrollIntoView({ block: 'nearest' });
    }
  }, [open, selectedIndex]);

  // Handle backdrop click
  const handleBackdropClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === e.currentTarget) {
        onClose();
      }
    },
    [onClose]
  );

  // Handle command click
  const handleCommandClick = useCallback(
    (command: Command) => {
      onSelect(command);
    },
    [onSelect]
  );

  if (!open || commands.length === 0) {
    return null;
  }

  return (
    <>
      {/* Invisible backdrop to catch clicks outside menu */}
      <div
        className="fixed inset-0 z-40"
        onClick={handleBackdropClick}
        aria-hidden="true"
      />

      {/* Dropdown menu - positioned above the typing preview bar */}
      <div
        ref={menuRef}
        role="listbox"
        aria-label="Slash commands"
        className="absolute bottom-full left-0 right-0 mb-1 z-50 bg-surface border border-border rounded-sm shadow-lg max-h-64 overflow-y-auto"
      >
        {commands.map((command, index) => {
          const isSelected = index === selectedIndex;
          return (
            <button
              key={command.name}
              ref={isSelected ? selectedRef : null}
              type="button"
              role="option"
              aria-selected={isSelected}
              onClick={() => handleCommandClick(command)}
              className={`w-full flex flex-col items-start px-3 py-3 text-left touch-target transition-colors ${
                isSelected ? 'bg-primary/10' : 'hover:bg-surface-alt'
              }`}
              style={{ minHeight: '44px' }}
            >
              <span className="font-mono text-sm text-text">{command.name}</span>
              <span className="text-xs text-text-muted mt-0.5">{command.description}</span>
            </button>
          );
        })}
      </div>
    </>
  );
}

// Helper hook for slash command state management
export function useSlashCommandState(inputValue: string, commands: Command[]) {
  // Detect if input starts with "/" and extract the filter
  const isSlashCommand = inputValue.startsWith('/');
  const slashFilter = isSlashCommand ? inputValue.slice(1) : '';

  // Filter commands
  const filterLower = slashFilter.toLowerCase();
  const filteredCommands = commands.filter((cmd) =>
    cmd.name.toLowerCase().includes(filterLower)
  );

  return {
    showMenu: isSlashCommand && commands.length > 0,
    slashFilter,
    filteredCommands,
  };
}
