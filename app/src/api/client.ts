import type { Session, SessionWithOutput, CreateSessionParams, PollData, ResizeParams, CreateFolderParams, CreateFolderResponse, PushSubscriptionJSON, Command, Project, Template, MaintainerStatus, InboxSubmission, DeployStatus, DeployTriggerResult, DeployAbortResult } from '../types';

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

  updateSession: (id: string, params: { name?: string; project_id?: string | null; tags?: string[] }): Promise<{ name?: string; project_id?: string; tags?: string[] }> =>
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

  uploadProject: async (name: string, file: File): Promise<{ path: string }> => {
    const formData = new FormData();
    formData.append('name', name);
    formData.append('file', file);

    const res = await fetch(
      `${BASE_URL}/folders/upload`,
      { method: 'POST', body: formData }
    );

    const data = await res.json();
    if (!data.success) {
      throw new Error(data.error || 'Upload failed');
    }
    return data.data;
  },

  uploadProjectFiles: async (name: string, files: FileList): Promise<{ path: string }> => {
    const formData = new FormData();
    formData.append('name', name);
    for (const file of Array.from(files)) {
      // Use webkitRelativePath if available (folder upload), otherwise just the name
      const relativePath = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
      formData.append('files', file, relativePath);
    }

    const res = await fetch(
      `${BASE_URL}/folders/upload`,
      { method: 'POST', body: formData }
    );

    const data = await res.json();
    if (!data.success) {
      throw new Error(data.error || 'Upload failed');
    }
    return data.data;
  },

  uploadImage: async (sessionId: string, file: File): Promise<{ path: string }> => {
    const formData = new FormData();
    formData.append('image', file);

    const res = await fetch(
      `${BASE_URL}/sessions/${encodeURIComponent(sessionId)}/upload`,
      { method: 'POST', body: formData }
    );

    const data = await res.json();
    if (!data.success) {
      throw new Error(data.error || 'Upload failed');
    }
    return data.data;
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
};
