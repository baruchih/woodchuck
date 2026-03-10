import { useState, useCallback, useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Layout } from '../components/Layout';
import { FolderPicker } from '../components/FolderPicker';
import { LogoWatermark } from '../components/LogoWatermark';
import { Button } from '../components/Button';
import { api } from '../api/client';
import { getFolderName, truncatePath } from '../utils/path';
import { useTemplates } from '../hooks/useTemplates';

type Step = 'folder' | 'name';

export function NewSessionPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const folderFromUrl = searchParams.get('folder');

  // If folder is provided in URL, start at step 2
  const [step, setStep] = useState<Step>(folderFromUrl ? 'name' : 'folder');
  const [selectedFolder, setSelectedFolder] = useState<string | null>(folderFromUrl);
  const [sessionName, setSessionName] = useState(folderFromUrl ? getFolderName(folderFromUrl) : '');
  const [sessionPrompt, setSessionPrompt] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { templates, refresh: refreshTemplates } = useTemplates();

  // Load templates on mount
  useEffect(() => {
    refreshTemplates();
  }, [refreshTemplates]);

  // Handle folder from URL on mount (in case of direct navigation)
  useEffect(() => {
    if (folderFromUrl && !selectedFolder) {
      setSelectedFolder(folderFromUrl);
      setSessionName(getFolderName(folderFromUrl));
      setStep('name');
    }
  }, [folderFromUrl, selectedFolder]);

  const handleSelectFolder = useCallback((folderPath: string) => {
    setSelectedFolder(folderPath);
    setSessionName(getFolderName(folderPath));
    setError(null);
    setStep('name');
  }, []);

  const handleChangeFolder = useCallback(() => {
    setStep('folder');
    setError(null);
  }, []);

  const handleSelectTemplate = useCallback((template: { name: string; folder: string; prompt: string }) => {
    setSelectedFolder(template.folder);
    setSessionName(getFolderName(template.folder));
    setSessionPrompt(template.prompt);
    setError(null);
    setStep('name');
  }, []);

  const handleCreateSession = useCallback(async () => {
    if (!selectedFolder || !sessionName.trim() || creating) return;

    setCreating(true);
    setError(null);

    try {
      const data = await api.createSession({
        name: sessionName.trim(),
        folder: selectedFolder,
        prompt: sessionPrompt,
      });

      navigate(`/session/${encodeURIComponent(data.session.id)}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to create session';
      setError(message);
      setCreating(false);
    }
  }, [selectedFolder, sessionName, sessionPrompt, creating, navigate]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && sessionName.trim()) {
      handleCreateSession();
    }
  }, [sessionName, handleCreateSession]);

  // Step 1: Folder selection (with optional template section)
  if (step === 'folder') {
    return (
      <Layout title="Select Project" showBack>
        <div className="relative min-h-full">
          <LogoWatermark />
          {error && (
            <div className="px-4 pt-4">
              <div className="bg-status-error/10 border border-status-error rounded-sm p-4">
                <p className="text-status-error text-xs">{error}</p>
              </div>
            </div>
          )}

          {/* Templates section */}
          {templates.length > 0 && (
            <div className="px-4 pt-4">
              <label className="block text-text text-xs uppercase tracking-wider mb-2">
                From Template
              </label>
              <div className="space-y-2 mb-4">
                {templates.map((template) => (
                  <button
                    key={template.id}
                    onClick={() => handleSelectTemplate(template)}
                    className="w-full text-left bg-surface border border-border rounded-sm p-3 hover:border-primary transition-colors"
                  >
                    <div className="text-text text-sm font-medium">{template.name}</div>
                    <div className="text-text-muted text-xs font-mono mt-1 truncate">
                      {truncatePath(template.folder, 40)}
                    </div>
                    {template.prompt && (
                      <div className="text-text-muted text-xs mt-1 truncate">
                        {template.prompt}
                      </div>
                    )}
                  </button>
                ))}
              </div>
              <div className="border-t border-border my-4" />
              <label className="block text-text text-xs uppercase tracking-wider mb-2">
                Or Choose a Folder
              </label>
            </div>
          )}

          <FolderPicker onSelectFolder={handleSelectFolder} />
        </div>
      </Layout>
    );
  }

  // Step 2: Name input + create
  return (
    <Layout title="New Session" showBack>
      <div className="relative min-h-full">
        <LogoWatermark />
        <div className="p-4 space-y-6">
          {error && (
            <div className="bg-status-error/10 border border-status-error rounded-sm p-4">
              <p className="text-status-error text-xs">{error}</p>
            </div>
          )}

          {/* Selected project display */}
          <div>
            <label className="block text-text text-xs uppercase tracking-wider mb-2">
              Project
            </label>
            <div className="flex items-center justify-between bg-surface-alt border border-border rounded-sm p-3">
              <span className="text-text text-sm font-mono truncate">
                {selectedFolder ? truncatePath(selectedFolder, 30) : ''}
              </span>
              <button
                onClick={handleChangeFolder}
                className="text-primary text-xs uppercase tracking-wider hover:underline ml-2 flex-shrink-0"
                disabled={creating}
              >
                Change
              </button>
            </div>
          </div>

          {/* Session name input */}
          <div>
            <label
              htmlFor="session-name"
              className="block text-text text-xs uppercase tracking-wider mb-2"
            >
              Session Name
            </label>
            <input
              id="session-name"
              type="text"
              value={sessionName}
              onChange={(e) => setSessionName(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Enter session name"
              disabled={creating}
              autoFocus
              className="w-full bg-surface border border-border rounded-sm p-3 text-text text-sm font-mono focus:outline-none focus:border-primary disabled:opacity-50"
            />
          </div>

          {/* Create button */}
          <Button
            onClick={handleCreateSession}
            disabled={!sessionName.trim()}
            loading={creating}
            fullWidth
            size="lg"
          >
            Start Session
          </Button>
        </div>
      </div>
    </Layout>
  );
}
