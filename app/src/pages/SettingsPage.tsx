import { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { Layout } from '../components/Layout';
import { Button } from '../components/Button';
import { useProjects } from '../hooks/useProjects';
import { api } from '../api/client';
import type { Project, MaintainerStatus, DeployStatus } from '../types';

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
  const { projects, refresh: refreshProjects } = useProjects();
  const [hiddenProjects, setHiddenProjects] = useState<Set<string>>(() => loadHiddenProjects());

  // Maintainer state
  const [maintainerStatus, setMaintainerStatus] = useState<MaintainerStatus | null>(null);
  const [maintainerOutput, setMaintainerOutput] = useState<string>('');
  const [showTerminal, setShowTerminal] = useState(false);
  const [inboxMessage, setInboxMessage] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const outputRef = useRef<HTMLPreElement>(null);

  // Deploy state
  const [deployStatus, setDeployStatus] = useState<DeployStatus | null>(null);
  const [deploying, setDeploying] = useState(false);

  // Initial load
  useEffect(() => {
    refreshProjects();
    refreshMaintainerStatus();
    refreshDeployStatus();
  }, [refreshProjects]);

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

  const refreshDeployStatus = async () => {
    try {
      const status = await api.getDeployStatus();
      setDeployStatus(status);
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
    } catch (e) {
      console.error('Deploy failed:', e);
    } finally {
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
                  >
                    {maintainerOutput || 'Loading...'}
                  </pre>
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

          {deployStatus ? (
            <div className="space-y-3">
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
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={handleRollback}
                      >
                        Rollback
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
            </div>
          ) : (
            <p className="text-text-muted text-sm italic">Deploy status unavailable</p>
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
      </div>
    </Layout>
  );
}
