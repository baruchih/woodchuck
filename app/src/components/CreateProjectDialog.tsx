import { useState, useEffect, useCallback, useRef } from 'react';
import { Button } from './Button';

interface CreateProjectDialogProps {
  open: boolean;
  onConfirm: (name: string) => void;
  onCancel: () => void;
}

export function CreateProjectDialog({
  open,
  onConfirm,
  onCancel,
}: CreateProjectDialogProps) {
  const [name, setName] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onCancel();
      }
    },
    [onCancel]
  );

  useEffect(() => {
    if (open) {
      document.addEventListener('keydown', handleKeyDown);
      document.body.style.overflow = 'hidden';
      // Focus input when dialog opens
      setTimeout(() => {
        inputRef.current?.focus();
      }, 0);
    }

    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.body.style.overflow = '';
    };
  }, [open, handleKeyDown]);

  // Reset name when dialog closes
  useEffect(() => {
    if (!open) {
      setName('');
    }
  }, [open]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (trimmed) {
      onConfirm(trimmed);
    }
  };

  if (!open) return null;

  return (
    <div
      className="modal-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          onCancel();
        }
      }}
    >
      <div
        className="bg-surface border border-border rounded-sm p-6 mx-4 max-w-sm w-full"
        role="dialog"
        aria-modal="true"
        aria-labelledby="dialog-title"
      >
        <h2 id="dialog-title" className="text-sm font-medium text-text uppercase tracking-wider mb-3">
          Create Project
        </h2>
        <form onSubmit={handleSubmit}>
          <input
            ref={inputRef}
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Project name"
            className="w-full bg-background border border-border rounded-sm px-3 py-2 text-text text-sm focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary mb-4"
          />
          <div className="flex gap-3 justify-end">
            <Button variant="ghost" size="sm" type="button" onClick={onCancel}>
              Cancel
            </Button>
            <Button variant="primary" size="sm" type="submit" disabled={!name.trim()}>
              Create
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
