import { getFolderName, truncatePath } from '../utils/path';

interface FolderCardProps {
  folderPath: string;
  onClick: () => void;
}

export function FolderCard({ folderPath, onClick }: FolderCardProps) {
  return (
    <button
      onClick={onClick}
      aria-label={`Select project ${getFolderName(folderPath)}`}
      className="w-full bg-surface border border-border rounded-sm p-4 text-left card-interactive touch-target hover:border-text-muted"
    >
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="w-4 h-4 shrink-0 text-primary"
          >
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
          </svg>
          <h3 className="text-text font-medium truncate">{getFolderName(folderPath)}</h3>
        </div>
        <p className="text-text-muted text-xs mt-1 truncate">{truncatePath(folderPath)}</p>
      </div>
    </button>
  );
}
