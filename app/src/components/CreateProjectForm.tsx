import { useState, useCallback, useRef } from 'react';
import { Button } from './Button';
import { api } from '../api/client';
import type { CreateFolderParams } from '../types';

interface CreateProjectFormProps {
  onSuccess: (folderPath: string) => void;
  onCancel?: () => void;
}

export function CreateProjectForm({ onSuccess, onCancel }: CreateProjectFormProps) {
  const [mode, setMode] = useState<'create' | 'clone' | 'upload'>('create');
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleSubmit = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (mode === 'upload') {
      if (!name.trim()) {
        setError('Please enter a folder name');
        return;
      }
      if (!file) {
        setError('Please select a zip file');
        return;
      }

      setSubmitting(true);
      try {
        const data = await api.uploadProject(name.trim(), file);
        onSuccess(data.path);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Upload failed';
        setError(message);
      } finally {
        setSubmitting(false);
      }
      return;
    }

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
  }, [mode, name, url, file, onSuccess]);

  const handleFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const selected = e.target.files?.[0] ?? null;
    setFile(selected);
    // Auto-fill name from filename if empty
    if (selected && !name.trim()) {
      const baseName = selected.name.replace(/\.zip$/i, '');
      setName(baseName);
    }
  }, [name]);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    const dropped = e.dataTransfer.files[0];
    if (dropped) {
      setFile(dropped);
      if (!name.trim()) {
        const baseName = dropped.name.replace(/\.zip$/i, '');
        setName(baseName);
      }
    }
  }, [name]);

  const inputStyles = 'w-full bg-background text-text border border-border rounded-sm px-4 py-3 text-sm outline-none focus:border-primary disabled:opacity-30 disabled:cursor-not-allowed';
  const labelStyles = 'block text-xs font-medium text-text uppercase tracking-wider mb-2';

  const isSubmitDisabled = submitting
    || (mode === 'create' && !name.trim())
    || (mode === 'clone' && !url.trim())
    || (mode === 'upload' && (!name.trim() || !file));

  return (
    <div className="border border-border rounded-sm p-4 space-y-4 bg-surface-alt">
      {/* Mode toggle */}
      <div className="flex gap-2 flex-wrap">
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
        <Button
          type="button"
          variant={mode === 'upload' ? 'primary' : 'ghost'}
          size="sm"
          onClick={() => { setMode('upload'); setError(null); }}
          disabled={submitting}
        >
          Upload Zip
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

        {mode === 'upload' && (
          <div>
            <label className={labelStyles}>Zip File</label>
            <input
              ref={fileInputRef}
              type="file"
              accept=".zip,application/zip"
              onChange={handleFileChange}
              disabled={submitting}
              className="hidden"
            />
            <div
              onClick={() => fileInputRef.current?.click()}
              onDragOver={(e) => e.preventDefault()}
              onDrop={handleDrop}
              className="w-full border-2 border-dashed border-border rounded-sm p-6 text-center cursor-pointer hover:border-primary transition-colors"
            >
              {file ? (
                <div>
                  <p className="text-text text-sm font-medium">{file.name}</p>
                  <p className="text-text-muted text-xs mt-1">
                    {(file.size / 1024 / 1024).toFixed(1)} MB
                  </p>
                </div>
              ) : (
                <div>
                  <p className="text-text-muted text-sm">Drop a .zip file here or click to browse</p>
                  <p className="text-text-muted text-xs mt-1">Max 100 MB</p>
                </div>
              )}
            </div>
          </div>
        )}

        <div>
          <label htmlFor="folder-name" className={labelStyles}>
            {mode === 'create' ? 'Folder Name' : mode === 'clone' ? 'Custom Name (optional)' : 'Project Name'}
          </label>
          <input
            id="folder-name"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={mode === 'create' ? 'my-project' : mode === 'clone' ? 'Leave empty to use repo name' : 'my-project'}
            disabled={submitting}
            className={inputStyles}
          />
        </div>

        <Button
          type="submit"
          fullWidth
          loading={submitting}
          disabled={isSubmitDisabled}
        >
          {mode === 'create' ? 'Create Folder' : mode === 'clone' ? 'Clone Repository' : 'Upload & Create'}
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
