import { useState, useEffect, useCallback } from 'react';
import { FolderCard } from './FolderCard';
import { CreateProjectForm } from './CreateProjectForm';
import { Button } from './Button';
import { useFolders } from '../hooks/useFolders';

interface FolderPickerProps {
  onSelectFolder: (path: string) => void;
}

export function FolderPicker({ onSelectFolder }: FolderPickerProps) {
  const { folders, loading, error, refresh } = useFolders();
  const [showCreateForm, setShowCreateForm] = useState(false);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const handleProjectCreated = useCallback((folderPath: string) => {
    setShowCreateForm(false);
    onSelectFolder(folderPath);
  }, [onSelectFolder]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="spinner" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-4 space-y-4">
        <div className="bg-status-error/10 border border-status-error rounded-sm p-4">
          <p className="text-status-error text-xs">{error}</p>
        </div>
        <Button variant="ghost" fullWidth onClick={refresh}>
          Retry
        </Button>
      </div>
    );
  }

  if (showCreateForm) {
    return (
      <div className="p-4">
        <CreateProjectForm
          onSuccess={handleProjectCreated}
          onCancel={() => setShowCreateForm(false)}
        />
      </div>
    );
  }

  if (folders.length === 0) {
    return (
      <div className="p-4 space-y-4">
        <p className="text-text text-sm text-center">No projects yet</p>
        <div className="grid grid-cols-2 gap-3">
          <button
            onClick={() => setShowCreateForm(true)}
            aria-label="Create new project"
            className="w-full border-2 border-dashed border-border rounded-sm p-4 text-center card-interactive touch-target hover:border-primary"
          >
            <span className="text-primary text-2xl block">+</span>
            <span className="text-text text-xs mt-1 block uppercase tracking-wider">New Project</span>
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="p-4">
      <div className="grid grid-cols-2 gap-3">
        {folders.map((folder) => (
          <FolderCard
            key={folder}
            folderPath={folder}
            onClick={() => onSelectFolder(folder)}
          />
        ))}
        <button
          onClick={() => setShowCreateForm(true)}
          aria-label="Create new project"
          className="w-full border-2 border-dashed border-border rounded-sm p-4 text-center card-interactive touch-target hover:border-primary"
        >
          <span className="text-primary text-2xl block">+</span>
          <span className="text-text text-xs mt-1 block uppercase tracking-wider">New Project</span>
        </button>
      </div>
    </div>
  );
}
