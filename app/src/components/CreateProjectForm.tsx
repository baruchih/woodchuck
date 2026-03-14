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
  const [files, setFiles] = useState<FileList | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const zipInputRef = useRef<HTMLInputElement>(null);
  const filesInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);

  // Summarize selected files for display
  const fileSummary = files
    ? files.length === 1
      ? files[0].name
      : `${files.length} files`
    : null;
  const totalSize = files
    ? Array.from(files).reduce((sum, f) => sum + f.size, 0)
    : 0;

  const isZip = files?.length === 1 && /\.zip$/i.test(files[0].name);

  const handleSubmit = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (mode === 'upload') {
      if (!name.trim()) {
        setError('Please enter a project name');
        return;
      }
      if (!files || files.length === 0) {
        setError('Please select files to upload');
        return;
      }

      setSubmitting(true);
      setUploadProgress(0);
      try {
        if (isZip) {
          const data = await api.uploadProject(name.trim(), files[0], setUploadProgress);
          onSuccess(data.path);
        } else {
          const data = await api.uploadProjectFiles(name.trim(), files, setUploadProgress);
          onSuccess(data.path);
        }
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
  }, [mode, name, url, files, isZip, onSuccess]);

  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const selected = e.target.files;
    if (!selected || selected.length === 0) return;
    setFiles(selected);
    // Auto-fill name if empty
    if (!name.trim()) {
      if (selected.length === 1) {
        setName(selected[0].name.replace(/\.zip$/i, ''));
      } else {
        // For webkitdirectory, the first path component is the folder name
        const firstPath = (selected[0] as File & { webkitRelativePath?: string }).webkitRelativePath;
        if (firstPath) {
          const folderName = firstPath.split('/')[0];
          if (folderName) setName(folderName);
        }
      }
    }
  }, [name]);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    const dropped = e.dataTransfer.files;
    if (dropped.length > 0) {
      setFiles(dropped);
      if (!name.trim()) {
        if (dropped.length === 1) {
          setName(dropped[0].name.replace(/\.zip$/i, ''));
        }
      }
    }
  }, [name]);

  const inputStyles = 'w-full bg-background text-text border border-border rounded-sm px-4 py-3 text-sm outline-none focus:border-primary disabled:opacity-30 disabled:cursor-not-allowed';
  const labelStyles = 'block text-xs font-medium text-text uppercase tracking-wider mb-2';

  const isSubmitDisabled = submitting
    || (mode === 'create' && !name.trim())
    || (mode === 'clone' && !url.trim())
    || (mode === 'upload' && (!name.trim() || !files || files.length === 0));

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
          Upload Files
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
            <label className={labelStyles}>Files</label>
            {/* Hidden file inputs */}
            <input
              ref={zipInputRef}
              type="file"
              accept=".zip,application/zip"
              onChange={handleFileSelect}
              disabled={submitting}
              className="hidden"
            />
            <input
              ref={filesInputRef}
              type="file"
              multiple
              onChange={handleFileSelect}
              disabled={submitting}
              className="hidden"
            />
            <input
              ref={folderInputRef}
              type="file"
              /* @ts-expect-error webkitdirectory is non-standard */
              webkitdirectory=""
              onChange={handleFileSelect}
              disabled={submitting}
              className="hidden"
            />
            <div
              onDragOver={(e) => e.preventDefault()}
              onDrop={handleDrop}
              className="w-full border-2 border-dashed border-border rounded-sm p-4 text-center cursor-pointer hover:border-primary transition-colors space-y-3"
            >
              {fileSummary ? (
                <div>
                  <p className="text-text text-sm font-medium">{fileSummary}</p>
                  <p className="text-text-muted text-xs mt-1">
                    {(totalSize / 1024 / 1024).toFixed(1)} MB
                    {isZip && ' (zip)'}
                  </p>
                </div>
              ) : (
                <p className="text-text-muted text-sm">Drop files here, or choose below</p>
              )}
              <div className="flex gap-2 justify-center flex-wrap">
                <button
                  type="button"
                  onClick={() => zipInputRef.current?.click()}
                  className="text-xs text-primary px-2 py-1 border border-primary/30 rounded hover:bg-primary/10"
                >
                  Zip file
                </button>
                <button
                  type="button"
                  onClick={() => filesInputRef.current?.click()}
                  className="text-xs text-primary px-2 py-1 border border-primary/30 rounded hover:bg-primary/10"
                >
                  Select files
                </button>
                <button
                  type="button"
                  onClick={() => folderInputRef.current?.click()}
                  className="text-xs text-primary px-2 py-1 border border-primary/30 rounded hover:bg-primary/10"
                >
                  Select folder
                </button>
              </div>
              <p className="text-text-muted text-[10px]">Max 100 MB</p>
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

        {submitting && mode === 'upload' && uploadProgress > 0 && (
          <div className="space-y-1">
            <div className="w-full h-1.5 bg-border rounded-full overflow-hidden">
              <div
                className="h-full bg-primary rounded-full transition-[width] duration-200"
                style={{ width: `${uploadProgress}%` }}
              />
            </div>
            <p className="text-[10px] text-text-muted text-center">{uploadProgress}%</p>
          </div>
        )}

        <Button
          type="submit"
          fullWidth
          loading={submitting}
          disabled={isSubmitDisabled}
        >
          {mode === 'create' ? 'Create Folder' : mode === 'clone' ? 'Clone Repository' : submitting && uploadProgress > 0 ? `Uploading... ${uploadProgress}%` : 'Upload & Create'}
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
