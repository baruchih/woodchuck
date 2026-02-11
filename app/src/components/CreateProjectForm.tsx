import { useState, useCallback } from 'react';
import { Button } from './Button';
import { api } from '../api/client';
import type { CreateFolderParams } from '../types';

interface CreateProjectFormProps {
  onSuccess: (folderPath: string) => void;
  onCancel?: () => void;
}

export function CreateProjectForm({ onSuccess, onCancel }: CreateProjectFormProps) {
  const [mode, setMode] = useState<'create' | 'clone'>('create');
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    let params: CreateFolderParams;

    if (mode === 'create') {
      if (!name.trim()) {
        setError('Please enter a folder name');
        return;
      }
      params = { action: 'create', name: name.trim() };
    } else {
      if (!url.trim()) {
        setError('Please enter a git repository URL');
        return;
      }
      params = name.trim()
        ? { action: 'clone', url: url.trim(), name: name.trim() }
        : { action: 'clone', url: url.trim() };
    }

    setSubmitting(true);

    try {
      const data = await api.createFolder(params);
      onSuccess(data.path);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to create project';
      setError(message);
    } finally {
      setSubmitting(false);
    }
  }, [mode, name, url, onSuccess]);

  const inputStyles = 'w-full bg-background text-text border border-border rounded-sm px-4 py-3 text-sm outline-none focus:border-primary disabled:opacity-30 disabled:cursor-not-allowed';
  const labelStyles = 'block text-xs font-medium text-text uppercase tracking-wider mb-2';

  return (
    <div className="border border-border rounded-sm p-4 space-y-4 bg-surface-alt">
      {/* Mode toggle */}
      <div className="flex gap-2">
        <Button
          type="button"
          variant={mode === 'create' ? 'primary' : 'ghost'}
          size="sm"
          onClick={() => { setMode('create'); setError(null); }}
          disabled={submitting}
        >
          Create Empty
        </Button>
        <Button
          type="button"
          variant={mode === 'clone' ? 'primary' : 'ghost'}
          size="sm"
          onClick={() => { setMode('clone'); setError(null); }}
          disabled={submitting}
        >
          Clone Repo
        </Button>
      </div>

      {/* Error display */}
      {error && (
        <div className="bg-status-error/10 border border-status-error rounded-sm p-3">
          <p className="text-status-error text-xs">{error}</p>
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-4">
        {mode === 'clone' && (
          <div>
            <label htmlFor="git-url" className={labelStyles}>
              Git URL
            </label>
            <input
              id="git-url"
              type="text"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="git@github.com:user/repo.git"
              disabled={submitting}
              className={inputStyles}
            />
          </div>
        )}

        <div>
          <label htmlFor="folder-name" className={labelStyles}>
            {mode === 'create' ? 'Folder Name' : 'Custom Name (optional)'}
          </label>
          <input
            id="folder-name"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={mode === 'create' ? 'my-project' : 'Leave empty to use repo name'}
            disabled={submitting}
            className={inputStyles}
          />
        </div>

        <Button
          type="submit"
          fullWidth
          loading={submitting}
          disabled={submitting || (mode === 'create' && !name.trim()) || (mode === 'clone' && !url.trim())}
        >
          {mode === 'create' ? 'Create Folder' : 'Clone Repository'}
        </Button>

        {onCancel && (
          <Button
            type="button"
            variant="ghost"
            fullWidth
            onClick={onCancel}
            disabled={submitting}
          >
            Cancel
          </Button>
        )}
      </form>
    </div>
  );
}
