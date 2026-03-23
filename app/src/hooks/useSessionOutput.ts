import { useEffect, useRef, useCallback, useState } from 'react';
import { useWS } from '../context/WebSocketContext';
import { api } from '../api/client';
import { detectContextActions } from '../utils/attention';
import type { ContextAction } from '../types';

interface UseSessionOutputParams {
  sessionId: string;
}

interface UseSessionOutputReturn {
  content: string;
  needsAttention: boolean;
  contextActions: ContextAction[];
  status: string;
  triggerFastPoll: () => void;
  notifySentText: (text: string) => void;
  forceRefresh: () => void;
}

const ENTER_RETRY_DELAY_MS = 2000;

/**
 * WebSocket-based terminal output hook. Replaces useTerminal's HTTP polling
 * with WebSocket subscribe/output messages for lower latency.
 */
export function useSessionOutput({ sessionId }: UseSessionOutputParams): UseSessionOutputReturn {
  const { subscribe, unsubscribe, onOutput, onStatus, onSubscribed } = useWS();
  const [content, setContent] = useState('');
  const [needsAttention, setNeedsAttention] = useState(false);
  const [contextActions, setContextActions] = useState<ContextAction[]>([]);
  const [status, setStatus] = useState('');

  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;
  const contentRef = useRef('');
  const enterRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sentTextRef = useRef<string | null>(null);

  // Subscribe to session output on mount
  useEffect(() => {
    if (!sessionId) return;

    subscribe(sessionId);

    return () => {
      unsubscribe(sessionId);
      if (enterRetryTimerRef.current) {
        clearTimeout(enterRetryTimerRef.current);
        enterRetryTimerRef.current = null;
      }
    };
  }, [sessionId, subscribe, unsubscribe]);

  // Handle initial subscription response (full output + status)
  useEffect(() => {
    const unsub = onSubscribed((msg) => {
      if (msg.session_id !== sessionIdRef.current) return;
      contentRef.current = msg.current_output;
      setContent(msg.current_output);
      setContextActions(detectContextActions(msg.current_output));
      setStatus(msg.status);
      setNeedsAttention(msg.status === 'needs_input');
    });
    return unsub;
  }, [onSubscribed]);

  // Handle streaming output updates (full content from poller)
  useEffect(() => {
    const unsub = onOutput((msg) => {
      if (msg.session_id !== sessionIdRef.current) return;
      contentRef.current = msg.content;
      setContent(msg.content);
      setContextActions(detectContextActions(msg.content));

      // Content changed: clear enter retry
      if (enterRetryTimerRef.current) {
        clearTimeout(enterRetryTimerRef.current);
        enterRetryTimerRef.current = null;
        sentTextRef.current = null;
      }
    });
    return unsub;
  }, [onOutput]);

  // Handle status updates
  useEffect(() => {
    const unsub = onStatus((msg) => {
      if (msg.session_id !== sessionIdRef.current) return;
      setStatus(msg.status);
      setNeedsAttention(msg.status === 'needs_input');
    });
    return unsub;
  }, [onStatus]);

  // triggerFastPoll — no-op with WebSocket (output arrives immediately)
  // Kept for API compatibility with components that call it after sending input
  const triggerFastPoll = useCallback(() => {
    // WebSocket pushes output immediately — no polling to speed up
  }, []);

  // Enter retry — if text still on prompt after 2s, resend Enter
  const notifySentText = useCallback((text: string) => {
    sentTextRef.current = text;
    if (enterRetryTimerRef.current) clearTimeout(enterRetryTimerRef.current);

    enterRetryTimerRef.current = setTimeout(async () => {
      const current = contentRef.current;
      const sent = sentTextRef.current;
      if (!current || !sent) {
        enterRetryTimerRef.current = null;
        sentTextRef.current = null;
        return;
      }

      const lastLine = current.trimEnd().split('\n').pop() || '';
      if (lastLine.includes(sent)) {
        try {
          await api.sendKey(sessionIdRef.current, 'Enter');
        } catch {
          // Ignore
        }
      }
      enterRetryTimerRef.current = null;
      sentTextRef.current = null;
    }, ENTER_RETRY_DELAY_MS);
  }, []);

  // Force refresh — unsubscribe and resubscribe to get fresh content
  const forceRefresh = useCallback(() => {
    if (!sessionIdRef.current) return;
    unsubscribe(sessionIdRef.current);
    contentRef.current = '';
    // Small delay to let unsubscribe process, then resubscribe
    setTimeout(() => {
      subscribe(sessionIdRef.current);
    }, 100);
  }, [subscribe, unsubscribe]);

  return { content, needsAttention, contextActions, status, triggerFastPoll, notifySentText, forceRefresh };
}
