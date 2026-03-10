interface Shortcut {
  key: string;
  description: string;
}

interface ShortcutsHelpProps {
  open: boolean;
  onClose: () => void;
  shortcuts: Shortcut[];
}

export function ShortcutsHelp({ open, onClose, shortcuts }: ShortcutsHelpProps) {
  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      onClick={onClose}
    >
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/60" />

      {/* Modal */}
      <div
        className="relative bg-surface border border-border rounded-sm shadow-lg max-w-sm w-full mx-4 p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-text text-sm font-semibold uppercase tracking-wider">
            Keyboard Shortcuts
          </h2>
          <button
            onClick={onClose}
            className="text-text-muted hover:text-text text-lg leading-none p-1"
            aria-label="Close"
          >
            &times;
          </button>
        </div>

        <table className="w-full text-sm">
          <tbody>
            {shortcuts.map((s) => (
              <tr key={s.key} className="border-b border-border last:border-0">
                <td className="py-2 pr-4">
                  <kbd className="inline-block px-2 py-0.5 bg-background border border-border rounded text-xs font-mono text-text">
                    {s.key}
                  </kbd>
                </td>
                <td className="py-2 text-text-muted">{s.description}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
