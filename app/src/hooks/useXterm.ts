import { useEffect, useRef, useCallback, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { CanvasAddon } from '@xterm/addon-canvas';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { decodeOsc52 } from '../utils/osc52';
import { createResizeScheduler } from '../utils/resizeScheduler';

// ── Interface ──

interface UseXtermParams {
  fontSize: number;
  onInput: (data: string) => void;
  onResize: (cols: number, rows: number) => void;
  /** Called with copied text when the browser refused a clipboard write (needs a user gesture) */
  onCopyBlocked?: (text: string) => void;
}

interface UseXtermReturn {
  containerRef: React.RefObject<HTMLDivElement>;
  /** Append raw terminal bytes, or replace everything when `reset` (a snapshot) */
  writeData: (data: string, reset: boolean) => void;
  focus: () => void;
  blur: () => void;
  scrollLines: (n: number) => void;
  isMouseTracking: () => boolean;
  getTextContent: () => { text: string; viewportLine: number };
  dimensions: { cols: number; rows: number } | null;
}

// ── Theme matching ansi.ts colors ──

const XTERM_THEME = {
  background: '#0a0a0a',
  foreground: '#e0e0e0',
  cursor: '#00bcd4',
  cursorAccent: '#0a0a0a',
  selectionBackground: '#00bcd433',
  selectionForeground: '#ffffff',
  // Standard colors (0-7)
  black: '#1a1a1a',
  red: '#ff6b6b',
  green: '#51cf66',
  yellow: '#ffd43b',
  blue: '#74c0fc',
  magenta: '#f783ac',
  cyan: '#66d9e8',
  white: '#e0e0e0',
  // Bright colors (8-15)
  brightBlack: '#666666',
  brightRed: '#ff8787',
  brightGreen: '#69db7c',
  brightYellow: '#ffe066',
  brightBlue: '#91a7ff',
  brightMagenta: '#f8a5c2',
  brightCyan: '#99e9f2',
  brightWhite: '#ffffff',
};

// ── Query suppression ──

/** tmux is the real terminal for the app and already answers its queries
 *  (device attributes, cursor position, colors...). Swallow them here so
 *  xterm's own replies don't get forwarded as typed input. */
function suppressQueryReplies(terminal: Terminal) {
  const swallow = () => true;
  const p = terminal.parser;
  p.registerCsiHandler({ final: 'c' }, swallow); // DA1
  p.registerCsiHandler({ prefix: '>', final: 'c' }, swallow); // DA2
  p.registerCsiHandler({ final: 'n' }, swallow); // DSR / cursor position report
  p.registerCsiHandler({ prefix: '?', final: 'n' }, swallow);
  p.registerCsiHandler({ intermediates: '$', final: 'p' }, swallow); // DECRQM
  p.registerCsiHandler({ prefix: '?', intermediates: '$', final: 'p' }, swallow);
  p.registerCsiHandler({ prefix: '>', final: 'q' }, swallow); // XTVERSION
  p.registerCsiHandler({ final: 't' }, swallow); // window reports
  p.registerDcsHandler({ intermediates: '$', final: 'q' }, swallow); // DECRQSS
  p.registerDcsHandler({ intermediates: '+', final: 'q' }, swallow); // XTGETTCAP
  // Color queries ("?"); color changes still apply
  for (const id of [4, 10, 11, 12]) {
    p.registerOscHandler(id, (data) => data.includes('?'));
  }
}

/** Focus in/out reports — tmux tracks focus itself */
const FOCUS_REPORTS = new Set(['\x1b[I', '\x1b[O']);

// ── Hook ──

export function useXterm({
  fontSize,
  onInput,
  onResize,
  onCopyBlocked,
}: UseXtermParams): UseXtermReturn {
  const containerRef = useRef<HTMLDivElement>(null!);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const onInputRef = useRef(onInput);
  onInputRef.current = onInput;
  const onCopyBlockedRef = useRef(onCopyBlocked);
  onCopyBlockedRef.current = onCopyBlocked;
  const onResizeRef = useRef(onResize);
  onResizeRef.current = onResize;
  // Every session resize makes the app redraw: send one per settled layout change
  const resizeSchedulerRef = useRef<ReturnType<typeof createResizeScheduler> | null>(null);
  if (!resizeSchedulerRef.current) {
    resizeSchedulerRef.current = createResizeScheduler((size) => onResizeRef.current(size.cols, size.rows));
  }
  const scheduleResize = resizeSchedulerRef.current.request;
  const [dimensions, setDimensions] = useState<{ cols: number; rows: number } | null>(null);

  // Initialize terminal
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    // Create terminal instance
    const terminal = new Terminal({
      cursorBlink: true,
      cursorStyle: 'block',
      fontFamily: '"JetBrains Mono", "Fira Code", Menlo, Monaco, "Courier New", monospace',
      fontSize,
      lineHeight: 1.4,
      theme: XTERM_THEME,
      scrollback: 10000,
      // Raw pty output already has \r\n
      convertEol: false,
      allowProposedApi: true,
    });

    // Create addons
    const canvasAddon = new CanvasAddon();
    const fitAddon = new FitAddon();
    const webLinksAddon = new WebLinksAddon();

    // Open terminal in container first (required before loading canvas addon)
    terminal.open(container);

    // Load addons after opening
    terminal.loadAddon(canvasAddon);
    terminal.loadAddon(fitAddon);
    terminal.loadAddon(webLinksAddon);

    suppressQueryReplies(terminal);

    // OSC 52: programs in the session (e.g. Claude Code's copy-on-select) put text
    // on the clipboard. The app runs on the server, so its own clipboard isn't the
    // viewer's — write it to the browser's clipboard instead.
    terminal.parser.registerOscHandler(52, (data) => {
      const text = decodeOsc52(data);
      if (!text) return true;
      if (!navigator.clipboard) {
        // Insecure context (plain http on a non-localhost address)
        onCopyBlockedRef.current?.(text);
      } else {
        navigator.clipboard.writeText(text).catch(() => onCopyBlockedRef.current?.(text));
      }
      return true;
    });

    // Store refs
    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;

    // Initial fit - retry a few times to handle layout that isn't ready yet.
    // On mobile, React may still be rendering when the first rAF fires.
    let fitAttempts = 0;
    const tryFit = () => {
      fitAttempts++;
      try {
        const proposedDims = fitAddon.proposeDimensions();
        if (!proposedDims) {
          if (fitAttempts < 5) {
            requestAnimationFrame(tryFit);
          }
          return;
        }
        fitAddon.fit();
        const dims = { cols: terminal.cols, rows: terminal.rows };
        setDimensions(dims);
        scheduleResize(dims);
      } catch (e) {
        if (fitAttempts < 5) {
          requestAnimationFrame(tryFit);
        }
      }
    };
    requestAnimationFrame(tryFit);

    // Handle keyboard input (desktop only — mobile uses a separate input bar)
    const inputDisposable = terminal.onData((data) => {
      if (FOCUS_REPORTS.has(data)) return;
      onInputRef.current(data);
    });

    // Cleanup
    return () => {
      inputDisposable.dispose();
      resizeSchedulerRef.current?.dispose();
      terminal.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
    };
    // Only run on mount/unmount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Handle font size changes
  useEffect(() => {
    const terminal = terminalRef.current;
    const fitAddon = fitAddonRef.current;
    if (!terminal || !fitAddon) return;

    try {
      terminal.options.fontSize = fontSize;
      fitAddon.fit();
      const dims = { cols: terminal.cols, rows: terminal.rows };
      setDimensions(dims);
      scheduleResize(dims);
    } catch (e) {
      console.error('Font size change fit failed:', e);
    }
  }, [fontSize, scheduleResize]);

  // Coming back to this window or tab: take the session's size back, even if
  // this view's size didn't change (another device may have resized it meanwhile)
  useEffect(() => {
    const reclaim = () => {
      const terminal = terminalRef.current;
      if (!terminal || document.visibilityState !== 'visible') return;
      scheduleResize({ cols: terminal.cols, rows: terminal.rows }, { force: true });
    };
    window.addEventListener('focus', reclaim);
    document.addEventListener('visibilitychange', reclaim);
    return () => {
      window.removeEventListener('focus', reclaim);
      document.removeEventListener('visibilitychange', reclaim);
    };
  }, [scheduleResize]);

  // Handle container resize — refit when WIDTH changes or on orientation change.
  // Height-only changes (mobile keyboard open/close) should not refit,
  // because resizing the session makes the app redraw, which causes a
  // visible jump. The terminal scrolls naturally instead.
  useEffect(() => {
    const container = containerRef.current;
    const fitAddon = fitAddonRef.current;
    const terminal = terminalRef.current;
    if (!container || !fitAddon || !terminal) return;

    let lastWidth = container.clientWidth;

    const doFit = () => {
      requestAnimationFrame(() => {
        try {
          const proposedDims = fitAddon.proposeDimensions();
          if (!proposedDims) return;
          fitAddon.fit();
          const dims = { cols: terminal.cols, rows: terminal.rows };
          setDimensions(dims);
          scheduleResize(dims);
          lastWidth = container.clientWidth;
        } catch (e) {
          console.error('Resize fit failed:', e);
        }
      });
    };

    const observer = new ResizeObserver(() => {
      const currentWidth = container.clientWidth;
      // Skip height-only changes (keyboard open/close)
      if (currentWidth === lastWidth) return;
      doFit();
    });

    observer.observe(container);

    // Also refit on orientation change (mobile rotate)
    const handleOrientation = () => doFit();
    window.addEventListener('orientationchange', handleOrientation);
    // screen.orientation API (more reliable on some devices)
    screen.orientation?.addEventListener('change', handleOrientation);

    return () => {
      observer.disconnect();
      window.removeEventListener('orientationchange', handleOrientation);
      screen.orientation?.removeEventListener('change', handleOrientation);
    };
  }, [scheduleResize]);

  // Write streamed terminal data. A snapshot replaces everything; otherwise
  // append. xterm keeps the viewport where it is if the user scrolled up.
  const writeData = useCallback((data: string, reset: boolean) => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    if (reset) {
      terminal.reset();
      terminal.write(data, () => terminal.scrollToBottom());
    } else {
      terminal.write(data);
    }
  }, []);

  // Focus terminal
  const focus = useCallback(() => {
    terminalRef.current?.focus();
  }, []);

  // Blur terminal
  const blur = useCallback(() => {
    terminalRef.current?.blur();
  }, []);

  // Whether the app asked for mouse reporting (e.g. Claude Code's fullscreen
  // renderer). Its history lives in the app, not xterm's scrollback.
  const isMouseTracking = useCallback(() => {
    return (terminalRef.current?.modes.mouseTrackingMode ?? 'none') !== 'none';
  }, []);

  // Scroll by N lines (positive = down, negative = up). When the app tracks the
  // mouse, send it wheel events instead (SGR encoding) so the app scrolls itself.
  const scrollLines = useCallback((n: number) => {
    const terminal = terminalRef.current;
    if (!terminal || n === 0) return;
    if (isMouseTracking()) {
      const button = n < 0 ? 64 : 65;
      const col = Math.max(1, Math.floor(terminal.cols / 2));
      const row = Math.max(1, Math.floor(terminal.rows / 2));
      const wheel = `\x1b[<${button};${col};${row}M`;
      onInputRef.current(wheel.repeat(Math.abs(n)));
      return;
    }
    terminal.scrollLines(n);
  }, [isMouseTracking]);

  // Get all terminal text content by reading the buffer directly (no side effects)
  const getTextContent = useCallback((): { text: string; viewportLine: number } => {
    const terminal = terminalRef.current;
    if (!terminal) return { text: '', viewportLine: 0 };
    const buffer = terminal.buffer.active;
    const lines: string[] = [];
    for (let i = 0; i < buffer.length; i++) {
      const line = buffer.getLine(i);
      if (line) lines.push(line.translateToString(true));
    }
    while (lines.length > 0 && lines[lines.length - 1] === '') {
      lines.pop();
    }
    return { text: lines.join('\n'), viewportLine: buffer.viewportY };
  }, []);

  return {
    containerRef,
    writeData,
    focus,
    blur,
    scrollLines,
    isMouseTracking,
    getTextContent,
    dimensions,
  };
}
