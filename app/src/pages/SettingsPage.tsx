import { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { Layout } from '../components/Layout';
import { Button } from '../components/Button';
import { useProjects } from '../hooks/useProjects';
import { useTemplates } from '../hooks/useTemplates';
import { api } from '../api/client';
import { ansiToHtml } from '../utils/ansi';
import { useTheme } from '../context/ThemeContext';
import { truncatePath } from '../utils/path';
import type { Project, MaintainerStatus, DeployStatus, DeployEvent } from '../types';

// Storage key for hidden projects
const HIDDEN_PROJECTS_KEY = 'woodchuck-hidden-projects';

function loadHiddenProjects(): Set<string> {
  try {
    const stored = localStorage.getItem(HIDDEN_PROJECTS_KEY);
    if (stored) {
      return new Set(JSON.parse(stored));
    }
  } catch {
    // Ignore parse errors
  }
  return new Set();
}

function saveHiddenProjects(hidden: Set<string>) {
  try {
    localStorage.setItem(HIDDEN_PROJECTS_KEY, JSON.stringify([...hidden]));
  } catch {
    // Ignore storage errors
  }
}

// Status badge colors
function statusColor(status: string): string {
  switch (status) {
    case 'working': return 'text-status-working';
    case 'needs_input': return 'text-status-needs-input';
    case 'error': return 'text-status-error';
    case 'resting': return 'text-status-resting';
    default: return 'text-text-muted';
  }
}

export function SettingsPage() {
  const navigate = useNavigate();
  const { theme, setTheme } = useTheme();
  const { projects, refresh: refreshProjects } = useProjects();
  const { templates, refresh: refreshTemplates, deleteTemplate } = useTemplates();
  const [hiddenProjects, setHiddenProjects] = useState<Set<string>>(() => loadHiddenProjects());

  // Maintainer state
  const [maintainerStatus, setMaintainerStatus] = useState<MaintainerStatus | null>(null);
  const [maintainerLoading, setMaintainerLoading] = useState(true);
  const [maintainerOutput, setMaintainerOutput] = useState<string>('');
  const [showTerminal, setShowTerminal] = useState(false);
  const [inboxMessage, setInboxMessage] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const outputRef = useRef<HTMLPreElement>(null);

  // Deploy state
  const [deployStatus, setDeployStatus] = useState<DeployStatus | null>(null);
  const [deploying, setDeploying] = useState(false);
  const [deployBranchInput, setDeployBranchInput] = useState('');
  const [savingBranch, setSavingBranch] = useState(false);
  const [deployHistory, setDeployHistory] = useState<DeployEvent[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [deployingLocal, setDeployingLocal] = useState(false);

  // Initial load
  useEffect(() => {
    refreshProjects();
    refreshTemplates();
    refreshMaintainerStatus();
    refreshDeployStatus();
    refreshDeployHistory();
  }, [refreshProjects, refreshTemplates]);

  // Poll maintainer + deploy status every 5s
  useEffect(() => {
    const interval = setInterval(() => {
      refreshMaintainerStatus();
      refreshDeployStatus();
    }, 5000);
    return () => clearInterval(interval);
  }, []);

  // Poll maintainer output when terminal is visible
  useEffect(() => {
    if (!showTerminal) return;
    const poll = async () => {
      try {
        const data = await api.pollMaintainer();
        setMaintainerOutput(data.content);
      } catch {
        // ignore
      }
    };
    poll();
    const interval = setInterval(poll, 2000);
    return () => clearInterval(interval);
  }, [showTerminal]);

  // Auto-scroll terminal output
  useEffect(() => {
    if (outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [maintainerOutput]);

  const refreshMaintainerStatus = async () => {
    try {
      const status = await api.getMaintainerStatus();
      setMaintainerStatus(status);
    } catch {
      // Maintainer might not be running
    } finally {
      setMaintainerLoading(false);
    }
  };

  const handleToggleHidden = useCallback((projectId: string) => {
    setHiddenProjects((prev) => {
      const next = new Set(prev);
      if (next.has(projectId)) {
        next.delete(projectId);
      } else {
        next.add(projectId);
      }
      saveHiddenProjects(next);
      return next;
    });
  }, []);

  const handleShowAll = useCallback(() => {
    setHiddenProjects(new Set());
    saveHiddenProjects(new Set());
  }, []);

  const handleHideAll = useCallback(() => {
    const allIds = new Set(projects.map((p) => p.id));
    setHiddenProjects(allIds);
    saveHiddenProjects(allIds);
  }, [projects]);

  const handlePauseMaintainer = async () => {
    try {
      await api.pauseMaintainer();
      await refreshMaintainerStatus();
    } catch (e) {
      console.error('Failed to pause maintainer:', e);
    }
  };

  const handleResumeMaintainer = async () => {
    try {
      await api.resumeMaintainer();
      await refreshMaintainerStatus();
    } catch (e) {
      console.error('Failed to resume maintainer:', e);
    }
  };

  const refreshDeployHistory = async () => {
    try {
      const data = await api.getDeployHistory();
      setDeployHistory(data.entries);
    } catch {
      // ignore
    }
  };

  const refreshDeployStatus = async () => {
    try {
      const status = await api.getDeployStatus();
      setDeployStatus(status);
      if (status.deploy_branch && !deployBranchInput) {
        setDeployBranchInput(status.deploy_branch);
      }
      // Reset deploying flag if server is back and not pending
      // (deploy succeeded — server re-exec'd)
      if (deploying && !status.pending) {
        setDeploying(false);
      }
    } catch {
      // Deploy endpoint might not exist on older server
    }
  };

  const handleTriggerDeploy = async () => {
    if (deploying) return;
    setDeploying(true);
    try {
      await api.triggerDeploy();
      await refreshDeployStatus();
      // Don't setDeploying(false) here — the server will re-exec.
      // refreshDeployStatus polling will reset it when the new server is up.
    } catch (e) {
      console.error('Deploy failed:', e);
      setDeploying(false);
    }
  };

  const handleAbortDeploy = async () => {
    try {
      await api.abortDeploy();
      await refreshDeployStatus();
    } catch (e) {
      console.error('Failed to abort deploy:', e);
    }
  };

  const handleSaveBranch = async () => {
    const branch = deployBranchInput.trim();
    if (!branch || savingBranch) return;
    setSavingBranch(true);
    try {
      await api.updateDeploySettings({ deploy_branch: branch });
      await refreshDeployStatus();
    } catch (e) {
      console.error('Failed to save deploy branch:', e);
    } finally {
      setSavingBranch(false);
    }
  };

  const handleDeployLocal = async () => {
    if (deployingLocal) return;
    setDeployingLocal(true);
    try {
      await api.deployLocal();
      await refreshDeployHistory();
    } catch (e) {
      console.error('Deploy local failed:', e);
      setDeployingLocal(false);
    }
  };

  const handleRollback = async () => {
    try {
      await api.rollbackDeploy();
    } catch (e) {
      console.error('Rollback failed:', e);
    }
  };

  const handleSubmitInbox = async () => {
    if (!inboxMessage.trim() || submitting) return;
    setSubmitting(true);
    try {
      await api.submitInboxItem({
        source: 'settings-ui',
        type: 'suggestion',
        message: inboxMessage.trim(),
      });
      setInboxMessage('');
      await refreshMaintainerStatus();
    } catch (e) {
      console.error('Failed to submit inbox item:', e);
    } finally {
      setSubmitting(false);
    }
  };

  const handleDeleteTemplate = async (id: string) => {
    try {
      await deleteTemplate(id);
    } catch (e) {
      console.error('Failed to delete template:', e);
    }
  };

  // Split projects into visible and hidden
  const visibleProjects: Project[] = [];
  const hiddenProjectsList: Project[] = [];
  for (const project of projects) {
    if (hiddenProjects.has(project.id)) {
      hiddenProjectsList.push(project);
    } else {
      visibleProjects.push(project);
    }
  }

  return (
    <Layout title="Settings" showBack>
      <div className="p-4 space-y-8">
        {/* Theme Section */}
        <section>
          <h2 className="text-sm font-medium text-text uppercase tracking-wider mb-4">
            Theme
          </h2>
          <div className="flex gap-2">
            <button
              onClick={() => setTheme('dark')}
              className={`px-4 py-2 rounded-sm text-sm font-medium transition-colors border ${
                theme === 'dark'
                  ? 'bg-primary text-background border-primary'
                  : 'bg-surface text-text-muted border-border hover:text-text'
              }`}
            >
              Dark
            </button>
            <button
              onClick={() => setTheme('light')}
              className={`px-4 py-2 rounded-sm text-sm font-medium transition-colors border ${
                theme === 'light'
                  ? 'bg-primary text-background border-primary'
                  : 'bg-surface text-text-muted border-border hover:text-text'
              }`}
            >
              Light
            </button>
          </div>
        </section>

        {/* Maintainer Section */}
        <section>
          <h2 className="text-sm font-medium text-text uppercase tracking-wider mb-4">
            Maintainer
          </h2>
          <p className="text-text-muted text-sm mb-4">
            Self-healing agent that monitors and fixes woodchuck automatically.
          </p>

          {maintainerStatus ? (
            <div className="space-y-3">
              {/* Status row */}
              <div className="flex items-center justify-between px-3 py-3 bg-surface border border-border rounded-sm">
                <div className="flex items-center gap-3">
                  <div className={`w-2 h-2 rounded-full ${
                    maintainerStatus.status === 'working' ? 'bg-status-working animate-pulse' :
                    maintainerStatus.status === 'needs_input' ? 'bg-status-needs-input' :
                    maintainerStatus.status === 'resting' ? 'bg-status-resting' :
                    maintainerStatus.status === 'error' ? 'bg-status-error' :
                    'bg-text-muted'
                  }`} />
                  <div>
                    <span className={`text-sm font-medium ${statusColor(maintainerStatus.status)}`}>
                      {maintainerStatus.status === 'not_running' ? 'Not Running' : maintainerStatus.status}
                    </span>
                    {maintainerStatus.current_task && (
                      <p className="text-xs text-text-muted mt-0.5">
                        Working on: {maintainerStatus.current_task}
                      </p>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {maintainerStatus.ralph_active && (
                    maintainerStatus.ralph_paused ? (
                      <Button variant="ghost" size="sm" onClick={handleResumeMaintainer}>
                        Resume
                      </Button>
                    ) : (
                      <Button variant="ghost" size="sm" onClick={handlePauseMaintainer}>
                        Pause
                      </Button>
                    )
                  )}
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => navigate(`/session/${encodeURIComponent(maintainerStatus.session_id)}`)}
                  >
                    Open
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setShowTerminal(!showTerminal)}
                  >
                    {showTerminal ? 'Hide' : 'Terminal'}
                  </Button>
                </div>
              </div>

              {/* Ralph loop badge */}
              <div className="flex items-center gap-2 px-3">
                <span className="text-xs text-text-muted">Ralph Loop:</span>
                <span className={`text-xs font-medium ${
                  !maintainerStatus.ralph_active ? 'text-text-muted' :
                  maintainerStatus.ralph_paused ? 'text-status-needs-input' :
                  'text-status-resting'
                }`}>
                  {!maintainerStatus.ralph_active ? 'Inactive' :
                   maintainerStatus.ralph_paused ? 'Paused' : 'Active'}
                </span>
              </div>

              {/* Mini terminal */}
              {showTerminal && (
                <div className="border border-border rounded-sm overflow-hidden">
                  <pre
                    ref={outputRef}
                    className="bg-background text-text text-xs p-2 h-64 overflow-auto font-mono whitespace-pre-wrap"
                    dangerouslySetInnerHTML={{ __html: maintainerOutput ? ansiToHtml(maintainerOutput) : 'Loading...' }}
                  />
                </div>
              )}

              {/* Inbox */}
              <div className="px-3 py-3 bg-surface border border-border rounded-sm">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-sm text-text">
                    Inbox
                  </span>
                  <span className="text-xs text-text-muted">
                    {maintainerStatus.inbox_count} pending
                  </span>
                </div>

                {maintainerStatus.inbox_items.length > 0 && (
                  <div className="space-y-1 mb-3">
                    {maintainerStatus.inbox_items.slice(0, 5).map((item) => (
                      <div key={item} className="text-xs text-text-muted font-mono truncate">
                        {item}
                      </div>
                    ))}
                    {maintainerStatus.inbox_items.length > 5 && (
                      <div className="text-xs text-text-muted">
                        ...and {maintainerStatus.inbox_items.length - 5} more
                      </div>
                    )}
                  </div>
                )}

                {/* Submit to inbox */}
                <div className="flex gap-2 mt-2">
                  <input
                    type="text"
                    value={inboxMessage}
                    onChange={(e) => setInboxMessage(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') handleSubmitInbox(); }}
                    placeholder="Report an issue or suggestion..."
                    className="flex-1 bg-background border border-border rounded-sm px-2 py-1.5 text-sm text-text placeholder:text-text-muted focus:outline-none focus:border-primary"
                  />
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={handleSubmitInbox}
                    disabled={!inboxMessage.trim() || submitting}
                  >
                    Send
                  </Button>
                </div>
              </div>
            </div>
          ) : maintainerLoading ? (
            <div className="flex items-center gap-2 py-4">
              <svg className="w-4 h-4 animate-spin text-primary" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
              <span className="text-text-muted text-sm">Loading maintainer status...</span>
            </div>
          ) : (
            <p className="text-text-muted text-sm italic">Maintainer not available</p>
          )}
        </section>

        {/* Deploy Section */}
        <section>
          <h2 className="text-sm font-medium text-text uppercase tracking-wider mb-4">
            Deploy
          </h2>
          <p className="text-text-muted text-sm mb-4">
            Self-upgrade pipeline. Swaps binary and restarts with 60s abort window.
          </p>

          {/* Auto-revert banner */}
          {deployHistory.length > 0 && deployHistory[0].outcome === 'reverted' && (
            <div className="bg-status-error/10 border border-status-error rounded-sm p-3 mb-4">
              <p className="text-status-error text-xs font-medium">
                Auto-reverted to main after consecutive failures on branch &quot;{deployHistory[0].branch}&quot;
              </p>
              <p className="text-text-muted text-[10px] mt-1">
                {new Date(deployHistory[0].timestamp).toLocaleString()}
                {deployHistory[0].outcome_detail && ` — ${deployHistory[0].outcome_detail}`}
              </p>
            </div>
          )}

          {deployStatus ? (
            <div className="space-y-3">
              {/* Branch configuration */}
              <div className="px-3 py-3 bg-surface border border-border rounded-sm">
                <label className="text-xs text-text-muted uppercase tracking-wider">Deploy Branch</label>
                <div className="flex items-center gap-2 mt-1.5">
                  <input
                    type="text"
                    value={deployBranchInput}
                    onChange={(e) => setDeployBranchInput(e.target.value)}
                    className="flex-1 bg-background border border-border rounded-sm px-2 py-1 text-sm text-text font-mono focus:outline-none focus:border-primary"
                    placeholder="main"
                  />
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={handleSaveBranch}
                    disabled={savingBranch || deployBranchInput.trim() === deployStatus.deploy_branch}
                  >
                    {savingBranch ? 'Saving...' : 'Save'}
                  </Button>
                </div>
                {deployStatus.current_git_branch && (
                  <p className="text-[10px] text-text-muted mt-1">
                    Currently on: <span className="font-mono">{deployStatus.current_git_branch}</span>
                  </p>
                )}
              </div>

              {/* Status + actions */}
              <div className="flex items-center justify-between px-3 py-3 bg-surface border border-border rounded-sm">
                <div>
                  <span className={`text-sm font-medium ${deployStatus.pending ? 'text-status-working' : 'text-text'}`}>
                    {deployStatus.pending ? 'Deploy in progress...' : 'Idle'}
                  </span>
                  {deployStatus.last_deploy && (
                    <p className="text-xs text-text-muted mt-0.5">
                      Last: {new Date(deployStatus.last_deploy).toLocaleString()}
                    </p>
                  )}
                  {deployStatus.cooldown_remaining_secs != null && deployStatus.cooldown_remaining_secs > 0 && (
                    <p className="text-xs text-text-muted mt-0.5">
                      Cooldown: {Math.ceil(deployStatus.cooldown_remaining_secs / 60)}m remaining
                    </p>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  {deployStatus.pending ? (
                    <Button variant="danger" size="sm" onClick={handleAbortDeploy}>
                      Abort
                    </Button>
                  ) : (
                    <>
                      <Button variant="ghost" size="sm" onClick={handleRollback}>
                        Rollback
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={handleDeployLocal}
                        disabled={deployingLocal}
                      >
                        {deployingLocal ? 'Building...' : 'Deploy Local'}
                      </Button>
                      <Button
                        variant="primary"
                        size="sm"
                        onClick={handleTriggerDeploy}
                        disabled={deploying || (deployStatus.cooldown_remaining_secs != null && deployStatus.cooldown_remaining_secs > 0)}
                      >
                        {deploying ? 'Deploying...' : 'Deploy'}
                      </Button>
                    </>
                  )}
                </div>
              </div>

              {/* Deploy history */}
              <div>
                <button
                  onClick={() => { setShowHistory(!showHistory); if (!showHistory) refreshDeployHistory(); }}
                  className="text-xs text-text-muted hover:text-primary uppercase tracking-wider"
                >
                  {showHistory ? 'Hide History' : 'Show History'}
                </button>
                {showHistory && (
                  <div className="mt-2 border border-border rounded-sm overflow-hidden">
                    {deployHistory.length === 0 ? (
                      <p className="text-xs text-text-muted p-3">No deploy history</p>
                    ) : (
                      deployHistory.map((event, i) => (
                        <div key={i} className="flex items-center justify-between px-3 py-2 border-b border-border/50 last:border-0 text-xs">
                          <div className="min-w-0">
                            <div className="flex items-center gap-2">
                              <span className={`font-medium ${
                                event.outcome === 'success' ? 'text-status-resting' :
                                event.outcome === 'failed' ? 'text-status-error' :
                                'text-status-needs-input'
                              }`}>
                                {event.outcome}
                              </span>
                              <span className="text-text-muted font-mono">{event.branch}</span>
                              <span className="text-text-muted font-mono">{event.commit.slice(0, 7)}</span>
                            </div>
                            {event.outcome_detail && (
                              <p className="text-text-muted text-[10px] mt-0.5 truncate">{event.outcome_detail}</p>
                            )}
                          </div>
                          <div className="text-text-muted shrink-0 ml-2 text-right">
                            <div>{event.trigger}</div>
                            <div className="text-[10px]">{new Date(event.timestamp).toLocaleString()}</div>
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                )}
              </div>
            </div>
          ) : (
            <p className="text-text-muted text-sm italic">Deploy status unavailable</p>
          )}
        </section>

        {/* Templates Section */}
        <section>
          <h2 className="text-sm font-medium text-text uppercase tracking-wider mb-4">
            Templates
          </h2>
          <p className="text-text-muted text-sm mb-4">
            Saved session presets. Create templates from the session info sheet.
          </p>

          {templates.length === 0 ? (
            <p className="text-text-muted text-sm italic">No templates yet</p>
          ) : (
            <div className="space-y-2">
              {templates.map((template) => (
                <div
                  key={template.id}
                  className="flex items-center justify-between px-3 py-3 bg-surface border border-border rounded-sm"
                >
                  <div className="min-w-0 flex-1">
                    <div className="text-sm text-text font-medium">{template.name}</div>
                    <div className="text-xs text-text-muted font-mono truncate mt-0.5">
                      {truncatePath(template.folder, 40)}
                    </div>
                  </div>
                  <Button
                    variant="danger"
                    size="sm"
                    onClick={() => handleDeleteTemplate(template.id)}
                  >
                    Delete
                  </Button>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* Hidden Projects Section */}
        <section>
          <h2 className="text-sm font-medium text-text uppercase tracking-wider mb-4">
            Project Visibility
          </h2>
          <p className="text-text-muted text-sm mb-4">
            Hidden projects won't appear on the home screen. Useful for presentations or demos.
          </p>

          {projects.length === 0 ? (
            <p className="text-text-muted text-sm italic">No projects yet</p>
          ) : (
            <>
              {/* Quick actions */}
              <div className="flex gap-2 mb-4">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={handleShowAll}
                  disabled={hiddenProjectsList.length === 0}
                >
                  Show All
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={handleHideAll}
                  disabled={visibleProjects.length === 0}
                >
                  Hide All
                </Button>
              </div>

              {/* Project list */}
              <div className="space-y-2">
                {projects.map((project) => {
                  const isHidden = hiddenProjects.has(project.id);
                  return (
                    <div
                      key={project.id}
                      className="flex items-center justify-between px-3 py-3 bg-surface border border-border rounded-sm"
                    >
                      <div className="flex items-center gap-3">
                        <svg
                          className="w-5 h-5 text-text-muted"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        >
                          <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                        </svg>
                        <span className={`text-sm ${isHidden ? 'text-text-muted' : 'text-text'}`}>
                          {project.name}
                        </span>
                      </div>

                      {/* Toggle button */}
                      <button
                        onClick={() => handleToggleHidden(project.id)}
                        className={`p-2 rounded-sm transition-colors ${
                          isHidden
                            ? 'text-text-muted hover:text-text hover:bg-surface-alt'
                            : 'text-primary hover:bg-primary/10'
                        }`}
                        aria-label={isHidden ? 'Show project' : 'Hide project'}
                        title={isHidden ? 'Show project' : 'Hide project'}
                      >
                        {isHidden ? (
                          <svg
                            className="w-5 h-5"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          >
                            <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
                            <line x1="1" y1="1" x2="23" y2="23" />
                          </svg>
                        ) : (
                          <svg
                            className="w-5 h-5"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          >
                            <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                            <circle cx="12" cy="12" r="3" />
                          </svg>
                        )}
                      </button>
                    </div>
                  );
                })}
              </div>

              {/* Summary */}
              {hiddenProjectsList.length > 0 && (
                <p className="text-text-muted text-xs mt-4">
                  {hiddenProjectsList.length} project{hiddenProjectsList.length !== 1 ? 's' : ''} hidden
                </p>
              )}
            </>
          )}
        </section>

        {/* Version */}
        <section className="pt-4 border-t border-border">
          <p className="text-text-muted text-xs text-center">
            Woodchuck v{__APP_VERSION__}
            {' · '}
            <span className="font-mono">{__APP_GIT_HASH__}</span>
            {' · '}
            Built {new Date(__BUILD_TIME__).toLocaleDateString()}
          </p>
        </section>
      </div>
    </Layout>
  );
}
