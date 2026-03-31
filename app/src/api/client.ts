import type { Session, SessionWithOutput, CreateSessionParams, PollData, ResizeParams, CreateFolderParams, CreateFolderResponse, PushSubscriptionJSON, Command, Project, Template, MaintainerStatus, InboxSubmission, DeployStatus, DeploySettings, DeployHistoryData, DeployTriggerResult, DeployAbortResult, SessionFilesData, FileContentData, OrphanedSession } from '../types';

const BASE_URL = '/api';

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: {
      'Content-Type': 'application/json',
    },
    ...options,
  });

  const data = await res.json();

  if (!data.success) {
    throw new Error(data.error || 'Unknown error');
  }

  return data.data;
}

export type ProgressCallback = (progress: number) => void;

/** Upload FormData via XHR with progress tracking. Returns parsed response data. */
function uploadWithProgress<T>(
  url: string,
  formData: FormData,
  onProgress?: ProgressCallback,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    xhr.timeout = 5 * 60 * 1000; // 5 minute timeout

    if (onProgress) {
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) {
          onProgress(Math.round((e.loaded / e.total) * 100));
        }
      };
    }

    xhr.onload = () => {
      if (xhr.status === 0 || xhr.status >= 500) {
        reject(new Error(`Server error (${xhr.status})`));
        return;
      }
      if (xhr.status === 413) {
        reject(new Error('File too large'));
        return;
      }
      try {
        const data = JSON.parse(xhr.responseText);
        if (!data.success) {
          reject(new Error(data.error || 'Upload failed'));
        } else {
          resolve(data.data);
        }
      } catch {
        reject(new Error(`Upload failed (${xhr.status})`));
      }
    };

    xhr.onerror = () => reject(new Error('Network error during upload'));
    xhr.onabort = () => reject(new Error('Upload aborted'));
    xhr.ontimeout = () => reject(new Error('Upload timed out'));

    xhr.send(formData);
  });
}

export const api = {
  getSessions: (): Promise<{ sessions: Session[] }> =>
    request('/sessions'),

  getSession: (id: string): Promise<SessionWithOutput> =>
    request(`/sessions/${encodeURIComponent(id)}`),

  createSession: (params: CreateSessionParams): Promise<{ session: Session }> =>
    request('/sessions', {
      method: 'POST',
      body: JSON.stringify(params),
    }),

  deleteSession: (id: string): Promise<{ killed: boolean }> =>
    request(`/sessions/${encodeURIComponent(id)}`, {
      method: 'DELETE'
    }),

  restartSession: (id: string): Promise<{ session: Session }> =>
    request(`/sessions/${encodeURIComponent(id)}/restart`, {
      method: 'POST',
    }),

  updateSession: (id: string, params: { name?: string; project_id?: string | null; tags?: string[]; ralph_enabled?: boolean }): Promise<{ name?: string; project_id?: string; tags?: string[]; ralph_enabled?: boolean }> =>
    request(`/sessions/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(params),
    }),

  renameSession: (id: string, name: string): Promise<{ name?: string; project_id?: string }> =>
    request(`/sessions/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ name }),
    }),

  sendInput: (id: string, text: string): Promise<{ sent: boolean }> =>
    request(`/sessions/${encodeURIComponent(id)}/input`, {
      method: 'POST',
      body: JSON.stringify({ text }),
    }),

  getFolders: (): Promise<{ folders: string[] }> =>
    request('/folders'),

  createFolder: (params: CreateFolderParams): Promise<CreateFolderResponse> =>
    request('/folders', {
      method: 'POST',
      body: JSON.stringify(params),
    }),

  poll: (id: string): Promise<PollData> =>
    request(`/sessions/${encodeURIComponent(id)}/poll`),

  getSessionFiles: (id: string, path?: string): Promise<SessionFilesData> => {
    const query = path ? `?path=${encodeURIComponent(path)}` : '';
    return request(`/sessions/${encodeURIComponent(id)}/files${query}`);
  },

  searchSessionFiles: (id: string, query: string): Promise<SessionFilesData> =>
    request(`/sessions/${encodeURIComponent(id)}/files?search=${encodeURIComponent(query)}`),

  getFileContent: (id: string, path: string): Promise<FileContentData> =>
    request(`/sessions/${encodeURIComponent(id)}/file-content?path=${encodeURIComponent(path)}`),

  resize: (id: string, params: ResizeParams): Promise<void> =>
    request(`/sessions/${encodeURIComponent(id)}/resize`, {
      method: 'POST',
      body: JSON.stringify(params),
    }),

  sendKey: (id: string, key: string): Promise<void> =>
    request(`/sessions/${encodeURIComponent(id)}/input`, {
      method: 'POST',
      body: JSON.stringify({ text: key }),
    }),

  health: (): Promise<{ status: string }> =>
    request('/health'),

  // Push notification endpoints
  getVapidPublicKey: (): Promise<{ publicKey: string | null }> =>
    request('/push/vapid-key'),

  subscribePush: (subscription: PushSubscriptionJSON): Promise<{ subscribed: boolean }> =>
    request('/push/subscribe', {
      method: 'POST',
      body: JSON.stringify(subscription),
    }),

  unsubscribePush: (endpoint: string): Promise<{ unsubscribed: boolean }> =>
    request('/push/unsubscribe', {
      method: 'POST',
      body: JSON.stringify({ endpoint }),
    }),

  getCommands: (sessionId?: string): Promise<{ commands: Command[] }> => {
    const query = sessionId ? `?session_id=${encodeURIComponent(sessionId)}` : '';
    return request(`/commands${query}`);
  },

  // Project endpoints
  getProjects: (): Promise<{ projects: Project[] }> =>
    request('/projects'),

  createProject: (name: string): Promise<{ project: Project }> =>
    request('/projects', {
      method: 'POST',
      body: JSON.stringify({ name }),
    }),

  renameProject: (id: string, name: string): Promise<{ name: string }> =>
    request(`/projects/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ name }),
    }),

  deleteProject: (id: string): Promise<{ deleted: boolean }> =>
    request(`/projects/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    }),

  // Maintainer endpoints
  getMaintainerStatus: (): Promise<MaintainerStatus> =>
    request('/maintainer/status'),

  submitInboxItem: (item: InboxSubmission): Promise<{ filename: string }> =>
    request('/maintainer/inbox', {
      method: 'POST',
      body: JSON.stringify(item),
    }),

  pauseMaintainer: (): Promise<void> =>
    request('/maintainer/pause', { method: 'POST' }),

  resumeMaintainer: (): Promise<void> =>
    request('/maintainer/resume', { method: 'POST' }),

  pollMaintainer: (): Promise<PollData> =>
    request(`/sessions/woodchuck-maintainer/poll`),

  // Deploy endpoints
  getDeployStatus: (): Promise<DeployStatus> =>
    request('/deploy/status'),

  triggerDeploy: (): Promise<DeployTriggerResult> =>
    request('/deploy/trigger', { method: 'POST' }),

  abortDeploy: (): Promise<DeployAbortResult> =>
    request('/deploy/abort', { method: 'POST' }),

  rollbackDeploy: (): Promise<DeployTriggerResult> =>
    request('/deploy/rollback', { method: 'POST' }),

  getDeploySettings: (): Promise<DeploySettings> =>
    request('/deploy/settings'),

  updateDeploySettings: (settings: { deploy_branch: string }): Promise<DeploySettings> =>
    request('/deploy/settings', {
      method: 'POST',
      body: JSON.stringify(settings),
    }),

  getDeployHistory: (): Promise<DeployHistoryData> =>
    request('/deploy/history'),

  deployLocal: (): Promise<DeployTriggerResult> =>
    request('/deploy/local', { method: 'POST' }),

  uploadProject: (name: string, file: File, onProgress?: ProgressCallback): Promise<{ path: string }> => {
    const formData = new FormData();
    formData.append('name', name);
    formData.append('file', file);
    return uploadWithProgress(`${BASE_URL}/folders/upload`, formData, onProgress);
  },

  uploadProjectFiles: (name: string, files: FileList, onProgress?: ProgressCallback): Promise<{ path: string }> => {
    const formData = new FormData();
    formData.append('name', name);
    for (const file of Array.from(files)) {
      const relativePath = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
      formData.append('files', file, relativePath);
    }
    return uploadWithProgress(`${BASE_URL}/folders/upload`, formData, onProgress);
  },

  uploadFiles: (sessionId: string, files: FileList, onProgress?: ProgressCallback): Promise<{ paths: string[] }> => {
    const formData = new FormData();
    for (const file of Array.from(files)) {
      formData.append('files', file, file.name);
    }
    return uploadWithProgress(
      `${BASE_URL}/sessions/${encodeURIComponent(sessionId)}/upload-files`,
      formData,
      onProgress,
    );
  },

  uploadImage: (sessionId: string, file: File, onProgress?: ProgressCallback): Promise<{ path: string }> => {
    const formData = new FormData();
    formData.append('image', file);
    return uploadWithProgress(
      `${BASE_URL}/sessions/${encodeURIComponent(sessionId)}/upload`,
      formData,
      onProgress,
    );
  },

  // Template endpoints
  getTemplates: (): Promise<{ templates: Template[] }> =>
    request('/templates'),

  createTemplate: (params: { name: string; folder: string; prompt: string }): Promise<{ template: Template }> =>
    request('/templates', {
      method: 'POST',
      body: JSON.stringify(params),
    }),

  deleteTemplate: (id: string): Promise<{ deleted: boolean }> =>
    request(`/templates/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    }),

  // Orphaned session recovery
  getOrphanedSessions: (): Promise<{ sessions: OrphanedSession[] }> =>
    request('/sessions/orphaned'),

  recoverSession: (id: string): Promise<{ session: Session }> =>
    request(`/sessions/${encodeURIComponent(id)}/recover`, {
      method: 'POST',
    }),

  discardOrphanedSession: (id: string): Promise<{ discarded: boolean }> =>
    request(`/sessions/${encodeURIComponent(id)}/orphaned`, {
      method: 'DELETE',
    }),
};
