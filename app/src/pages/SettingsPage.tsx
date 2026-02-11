import { useState, useEffect, useCallback } from 'react';
import { Layout } from '../components/Layout';
import { Button } from '../components/Button';
import { useProjects } from '../hooks/useProjects';
import type { Project } from '../types';

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

export function SettingsPage() {
  const { projects, refresh: refreshProjects } = useProjects();
  const [hiddenProjects, setHiddenProjects] = useState<Set<string>>(() => loadHiddenProjects());

  // Initial load
  useEffect(() => {
    refreshProjects();
  }, [refreshProjects]);

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
      <div className="p-4">
        {/* Hidden Projects Section */}
        <section className="mb-8">
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
                          // Eye-off icon (hidden)
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
                          // Eye icon (visible)
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

        {/* Future settings sections can go here */}
      </div>
    </Layout>
  );
}
