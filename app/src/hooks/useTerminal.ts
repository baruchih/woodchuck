import { useEffect, useRef, useCallback, useState } from 'react';
import { api } from '../api/client';
import { detectContextActions } from '../utils/attention';
import type { ContextAction } from '../types';

// ── Interfaces ──

interface UseTerminalParams {
  sessionId: string;
}

interface UseTerminalReturn {
  content: string;
  needsAttention: boolean;
  contextActions: ContextAction[];
  status: string;
  triggerFastPoll: () => void;
  notifySentText: (text: string) => void;
}

// ── Constants ──

const NORMAL_POLL_MS = 1000;
const FAST_POLL_MS = 200;
const FAST_POLL_DURATION_MS = 5000;
const ENTER_RETRY_DELAY_MS = 2000;

// ── Hook ──

export function useTerminal({ sessionId }: UseTerminalParams): UseTerminalReturn {
  const [content, setContent] = useState('');
  const [needsAttention, setNeedsAttention] = useState(false);
  const [contextActions, setContextActions] = useState<ContextAction[]>([]);
  const [status, setStatus] = useState('');

  // All mutable state in refs to keep setInterval callback stable
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;

  const lastContentRef = useRef('');
  const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const fastPollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const enterRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sentTextRef = useRef<string | null>(null);
  const isFetchingRef = useRef(false);

  // The poll function — called by setInterval, never breaks the chain
  const poll = useCallback(async () => {
    if (isFetchingRef.current) return; // skip if previous fetch still in flight
    isFetchingRef.current = true;
    try {
      const data = await api.poll(sessionIdRef.current);
      if (data.status) {
        setStatus(data.status);
        // Use backend status as source of truth for attention
        // Backend has more comprehensive patterns than frontend detectAttention()
        setNeedsAttention(data.status === 'needs_input');
      }

      if (data.content !== lastContentRef.current) {
        lastContentRef.current = data.content;
        setContent(data.content);
        setContextActions(detectContextActions(data.content));

        // Content changed: clear enter retry
        if (enterRetryTimerRef.current) {
          clearTimeout(enterRetryTimerRef.current);
          enterRetryTimerRef.current = null;
          sentTextRef.current = null;
        }
      }
    } catch {
      // Ignore poll errors
    } finally {
      isFetchingRef.current = false;
    }
  }, []);

  // Start/stop polling with setInterval
  const setPollInterval = useCallback((ms: number) => {
    if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
    pollIntervalRef.current = setInterval(poll, ms);
  }, [poll]);

  // Main polling effect
  useEffect(() => {
    // Immediately poll once, then start fast interval
    poll();
    setPollInterval(FAST_POLL_MS);

    // After initial burst, revert to normal
    const revertTimer = setTimeout(() => {
      setPollInterval(NORMAL_POLL_MS);
    }, FAST_POLL_DURATION_MS);

    return () => {
      clearTimeout(revertTimer);
      if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
      if (fastPollTimerRef.current) clearTimeout(fastPollTimerRef.current);
      if (enterRetryTimerRef.current) clearTimeout(enterRetryTimerRef.current);
      lastContentRef.current = '';
    };
  }, [sessionId, poll, setPollInterval]);

  // Trigger fast polling (called after user sends input)
  const triggerFastPoll = useCallback(() => {
    setPollInterval(FAST_POLL_MS);
    poll(); // immediate poll

    if (fastPollTimerRef.current) clearTimeout(fastPollTimerRef.current);
    fastPollTimerRef.current = setTimeout(() => {
      setPollInterval(NORMAL_POLL_MS);
      fastPollTimerRef.current = null;
    }, FAST_POLL_DURATION_MS);
  }, [setPollInterval, poll]);

  // Enter retry — if text still on prompt after 2s, resend Enter
  const notifySentText = useCallback((text: string) => {
    sentTextRef.current = text;
    if (enterRetryTimerRef.current) clearTimeout(enterRetryTimerRef.current);

    enterRetryTimerRef.current = setTimeout(async () => {
      const current = lastContentRef.current;
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
          triggerFastPoll();
        } catch {
          // Ignore
        }
      }
      enterRetryTimerRef.current = null;
      sentTextRef.current = null;
    }, ENTER_RETRY_DELAY_MS);
  }, [triggerFastPoll]);

  return { content, needsAttention, contextActions, status, triggerFastPoll, notifySentText };
}
