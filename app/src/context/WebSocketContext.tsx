import { createContext, useContext, useEffect, useRef, useState, useCallback, type ReactNode } from 'react';
import type {
  ServerMessage, OutputMessage, StatusMessage, ErrorMessage, ClientMessage,
  SubscribedMessage, SessionsMessage, SessionCreatedMessage, SessionDeletedMessage,
  SessionUpdatedMessage, SessionEndedMessage,
} from '../types';

type PendingRequest = {
  resolve: (msg: unknown) => void;
  reject: (err: Error) => void;
  timer: number;
};

interface WebSocketContextValue {
  connected: boolean;
  subscribe: (sessionId: string) => void;
  unsubscribe: (sessionId: string) => void;
  sendInput: (sessionId: string, text: string) => void;
  sendRawInput: (sessionId: string, data: string) => void;
  resize: (sessionId: string, cols: number, rows: number) => void;
  onOutput: (callback: (msg: OutputMessage) => void) => () => void;
  onStatus: (callback: (msg: StatusMessage) => void) => () => void;
  onError: (callback: (msg: ErrorMessage) => void) => () => void;
  wsRequest: <T>(msg: ClientMessage) => Promise<T>;
  onSessions: (cb: (msg: SessionsMessage) => void) => () => void;
  onSessionCreated: (cb: (msg: SessionCreatedMessage) => void) => () => void;
  onSessionDeleted: (cb: (msg: SessionDeletedMessage | SessionEndedMessage) => void) => () => void;
  onSessionUpdated: (cb: (msg: SessionUpdatedMessage) => void) => () => void;
  onSubscribed: (cb: (msg: SubscribedMessage) => void) => () => void;
}

const WebSocketContext = createContext<WebSocketContextValue | null>(null);

export function useWS(): WebSocketContextValue {
  const ctx = useContext(WebSocketContext);
  if (!ctx) {
    throw new Error('useWS must be used inside WebSocketProvider');
  }
  return ctx;
}

interface WebSocketProviderProps {
  children: ReactNode;
}

export function WebSocketProvider({ children }: WebSocketProviderProps) {
  const [connected, setConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<number>();
  const subscriptionsRef = useRef<Set<string>>(new Set());

  const outputListenersRef = useRef<Set<(msg: OutputMessage) => void>>(new Set());
  const statusListenersRef = useRef<Set<(msg: StatusMessage) => void>>(new Set());
  const errorListenersRef = useRef<Set<(msg: ErrorMessage) => void>>(new Set());
  const sessionsListenersRef = useRef<Set<(msg: SessionsMessage) => void>>(new Set());
  const sessionCreatedListenersRef = useRef<Set<(msg: SessionCreatedMessage) => void>>(new Set());
  const sessionDeletedListenersRef = useRef<Set<(msg: SessionDeletedMessage | SessionEndedMessage) => void>>(new Set());
  const sessionUpdatedListenersRef = useRef<Set<(msg: SessionUpdatedMessage) => void>>(new Set());
  const subscribedListenersRef = useRef<Set<(msg: SubscribedMessage) => void>>(new Set());
  const pendingRequestsRef = useRef<Map<string, PendingRequest>>(new Map());
  const lastMessageTimeRef = useRef<number>(Date.now());
  const healthCheckRef = useRef<number>();

  const getWebSocketUrl = useCallback(() => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = window.location.host;
    return `${protocol}//${host}/ws`;
  }, []);

  const send = useCallback((msg: ClientMessage) => {
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    } else if (ws?.readyState === WebSocket.CLOSED || ws?.readyState === WebSocket.CLOSING || !ws) {
      // Connection died — trigger reconnect
      connect();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const resubscribeAll = useCallback(() => {
    subscriptionsRef.current.forEach((sessionId) => {
      send({ type: 'subscribe', session_id: sessionId });
    });
  }, [send]);

  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      return;
    }

    const url = getWebSocketUrl();
    const ws = new WebSocket(url);

    ws.onopen = () => {
      // Reject all pending requests from previous connection
      pendingRequestsRef.current.forEach((pending) => {
        clearTimeout(pending.timer);
        pending.reject(new Error('connection reset'));
      });
      pendingRequestsRef.current.clear();

      setConnected(true);
      resubscribeAll();
    };

    ws.onclose = () => {
      setConnected(false);
      wsRef.current = null;

      // Reconnect after delay
      reconnectTimeoutRef.current = window.setTimeout(() => {
        connect();
      }, 2000);
    };

    ws.onerror = () => {
      // Error will be followed by close event
    };

    ws.onmessage = (event) => {
      lastMessageTimeRef.current = Date.now();
      try {
        const msg = JSON.parse(event.data) as ServerMessage;

        // Resolve pending request if this message carries a request_id
        if ('request_id' in msg && msg.request_id) {
          const pending = pendingRequestsRef.current.get(msg.request_id);
          if (pending) {
            clearTimeout(pending.timer);
            pendingRequestsRef.current.delete(msg.request_id);
            pending.resolve(msg);
          }
        }

        switch (msg.type) {
          case 'output':
            outputListenersRef.current.forEach((cb) => cb(msg));
            break;
          case 'status':
            statusListenersRef.current.forEach((cb) => cb(msg));
            break;
          case 'error':
            errorListenersRef.current.forEach((cb) => cb(msg));
            break;
          case 'sessions':
            sessionsListenersRef.current.forEach((cb) => cb(msg));
            break;
          case 'session_created':
            sessionCreatedListenersRef.current.forEach((cb) => cb(msg));
            break;
          case 'session_deleted':
            sessionDeletedListenersRef.current.forEach((cb) => cb(msg));
            break;
          case 'session_ended':
            sessionDeletedListenersRef.current.forEach((cb) => cb(msg));
            break;
          case 'session_updated':
            sessionUpdatedListenersRef.current.forEach((cb) => cb(msg));
            break;
          case 'subscribed':
            subscribedListenersRef.current.forEach((cb) => cb(msg));
            break;
          case 'ack':
            // Already handled above via request_id resolution
            break;
          case 'session_detail':
            // Already handled above via request_id resolution
            break;
        }
      } catch {
        console.error('Failed to parse WebSocket message');
      }
    };

    wsRef.current = ws;
  }, [getWebSocketUrl, resubscribeAll]);

  // Initial connection
  useEffect(() => {
    connect();

    return () => {
      clearTimeout(reconnectTimeoutRef.current);
      wsRef.current?.close();
    };
  }, [connect]);

  // Health check: detect silent WebSocket disconnections
  // If we have active subscriptions but haven't received any message in 30s,
  // the connection is likely dead (half-open TCP). Force reconnect.
  useEffect(() => {
    healthCheckRef.current = window.setInterval(() => {
      const ws = wsRef.current;
      const hasSubscriptions = subscriptionsRef.current.size > 0;
      const elapsed = Date.now() - lastMessageTimeRef.current;

      if (hasSubscriptions && elapsed > 30_000) {
        if (ws && ws.readyState === WebSocket.OPEN) {
          console.warn(`WebSocket stale (no message for ${Math.round(elapsed / 1000)}s) — reconnecting`);
          ws.close();
          // onclose handler will trigger reconnect
        }
      }
    }, 15_000);

    return () => {
      clearInterval(healthCheckRef.current);
    };
  }, []);

  // Handle visibility change (phone sleep/background)
  // Use ref to avoid re-registering on every connected change
  const connectedRef = useRef(connected);
  connectedRef.current = connected;

  useEffect(() => {
    const handleVisibility = () => {
      if (document.visibilityState === 'visible' && !connectedRef.current) {
        connect();
      }
    };

    document.addEventListener('visibilitychange', handleVisibility);
    return () => document.removeEventListener('visibilitychange', handleVisibility);
  }, [connect]);

  const subscribe = useCallback((sessionId: string) => {
    subscriptionsRef.current.add(sessionId);
    send({ type: 'subscribe', session_id: sessionId });
  }, [send]);

  const unsubscribe = useCallback((sessionId: string) => {
    subscriptionsRef.current.delete(sessionId);
    send({ type: 'unsubscribe', session_id: sessionId });
  }, [send]);

  const sendInput = useCallback((sessionId: string, text: string) => {
    send({ type: 'input', session_id: sessionId, text });
  }, [send]);

  const sendRawInput = useCallback((sessionId: string, data: string) => {
    send({ type: 'input', session_id: sessionId, text: data, raw: true });
  }, [send]);

  const resize = useCallback((sessionId: string, cols: number, rows: number) => {
    send({ type: 'resize', session_id: sessionId, cols, rows });
  }, [send]);

  const onOutput = useCallback((callback: (msg: OutputMessage) => void) => {
    outputListenersRef.current.add(callback);
    return () => {
      outputListenersRef.current.delete(callback);
    };
  }, []);

  const onStatus = useCallback((callback: (msg: StatusMessage) => void) => {
    statusListenersRef.current.add(callback);
    return () => {
      statusListenersRef.current.delete(callback);
    };
  }, []);

  const onError = useCallback((callback: (msg: ErrorMessage) => void) => {
    errorListenersRef.current.add(callback);
    return () => {
      errorListenersRef.current.delete(callback);
    };
  }, []);

  const wsRequest = useCallback(<T,>(msg: ClientMessage): Promise<T> => {
    return new Promise<T>((resolve, reject) => {
      const requestId = crypto.randomUUID();
      const msgWithId = { ...msg, request_id: requestId };

      const timer = window.setTimeout(() => {
        pendingRequestsRef.current.delete(requestId);
        reject(new Error('WebSocket request timed out'));
      }, 10_000);

      pendingRequestsRef.current.set(requestId, {
        resolve: resolve as (msg: unknown) => void,
        reject,
        timer,
      });

      const ws = wsRef.current;
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(msgWithId));
      } else {
        clearTimeout(timer);
        pendingRequestsRef.current.delete(requestId);
        reject(new Error('WebSocket not connected'));
      }
    });
  }, []);

  const onSessions = useCallback((cb: (msg: SessionsMessage) => void) => {
    sessionsListenersRef.current.add(cb);
    return () => { sessionsListenersRef.current.delete(cb); };
  }, []);

  const onSessionCreated = useCallback((cb: (msg: SessionCreatedMessage) => void) => {
    sessionCreatedListenersRef.current.add(cb);
    return () => { sessionCreatedListenersRef.current.delete(cb); };
  }, []);

  const onSessionDeleted = useCallback((cb: (msg: SessionDeletedMessage | SessionEndedMessage) => void) => {
    sessionDeletedListenersRef.current.add(cb);
    return () => { sessionDeletedListenersRef.current.delete(cb); };
  }, []);

  const onSessionUpdated = useCallback((cb: (msg: SessionUpdatedMessage) => void) => {
    sessionUpdatedListenersRef.current.add(cb);
    return () => { sessionUpdatedListenersRef.current.delete(cb); };
  }, []);

  const onSubscribed = useCallback((cb: (msg: SubscribedMessage) => void) => {
    subscribedListenersRef.current.add(cb);
    return () => { subscribedListenersRef.current.delete(cb); };
  }, []);

  const value: WebSocketContextValue = {
    connected,
    subscribe,
    unsubscribe,
    sendInput,
    sendRawInput,
    resize,
    onOutput,
    onStatus,
    onError,
    wsRequest,
    onSessions,
    onSessionCreated,
    onSessionDeleted,
    onSessionUpdated,
    onSubscribed,
  };

  return (
    <WebSocketContext.Provider value={value}>
      {children}
    </WebSocketContext.Provider>
  );
}
