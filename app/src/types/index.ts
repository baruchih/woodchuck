export type SessionStatus = 'resting' | 'working' | 'needs_input' | 'error';

export interface Session {
  id: string;
  name: string;
  folder: string;
  git_branch?: string;
  status: SessionStatus;
  created_at: string;
  updated_at: string;
  working_since?: string;
  project_id?: string;
  last_input?: string;
}

export interface Project {
  id: string;
  name: string;
  created_at: string;
}

export interface CreateSessionParams {
  name: string;
  folder: string;
  prompt: string;
}

export interface SessionWithOutput {
  session: Session;
  recent_output: string;
}

// WebSocket messages - Server to Client
export interface OutputMessage {
  type: 'output';
  session_id: string;
  content: string;
  timestamp: string;
}

export interface StatusMessage {
  type: 'status';
  session_id: string;
  status: SessionStatus;
  timestamp: string;
}

export interface ErrorMessage {
  type: 'error';
  session_id: string;
  message: string;
}

export interface SessionEndedMessage {
  type: 'session_ended';
  session_id: string;
  timestamp: string;
}

export type ServerMessage = OutputMessage | StatusMessage | ErrorMessage | SessionEndedMessage;

// WebSocket messages - Client to Server
export interface SubscribeMessage {
  type: 'subscribe';
  session_id: string;
}

export interface UnsubscribeMessage {
  type: 'unsubscribe';
  session_id: string;
}

export interface InputMessage {
  type: 'input';
  session_id: string;
  text: string;
}

export type ClientMessage = SubscribeMessage | UnsubscribeMessage | InputMessage;

// API Response types
export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
  code?: string;
}

// Poll endpoint types
export interface PollData {
  content: string;
  status: string;
}

// Resize params
export interface ResizeParams {
  cols: number;
  rows: number;
}

// Poll mode for fast/normal polling
export type PollMode = 'normal' | 'fast';

// Create folder params (discriminated union)
export type CreateFolderParams =
  | { action: 'create'; name: string }
  | { action: 'clone'; url: string; name?: string };

export interface CreateFolderResponse {
  path: string;
}

// Context-aware actions detected from terminal output
export interface ContextAction {
  label: string;
  key: string;
  variant: 'primary' | 'ghost' | 'danger';
}

// PWA Install Prompt Event
export interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

// Push Notification types
export type PushPermissionState = 'prompt' | 'granted' | 'denied' | 'unsupported';

// Slash command for autocomplete
export interface Command {
  name: string;
  description: string;
  usage: string;
  has_args: boolean;
}

export interface PushSubscriptionKeys {
  p256dh: string;
  auth: string;
}

export interface PushSubscriptionJSON {
  endpoint: string;
  keys: PushSubscriptionKeys;
}
