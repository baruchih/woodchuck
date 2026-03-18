import { useEffect, useRef, useCallback, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { CanvasAddon } from '@xterm/addon-canvas';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';

// ── Interface ──

interface UseXtermParams {
  fontSize: number;
  onInput: (data: string) => void;
  onResize: (cols: number, rows: number) => void;
}

interface UseXtermReturn {
  containerRef: React.RefObject<HTMLDivElement>;
  write: (content: string) => void;
  resetWriteState: () => void;
  focus: () => void;
  blur: () => void;
  scrollLines: (n: number) => void;
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

// ── Internal write helper (not a hook — plain function for recursive use) ──

/** Write content to the terminal, clearing scrollback first. After the write
 *  completes, automatically flushes any content that arrived during the write. */
function doTerminalWrite(
  terminal: Terminal,
  content: string,
  lastContentRef: React.MutableRefObject<string>,
  pendingContentRef: React.MutableRefObject<string | null>,
  writingRef: React.MutableRefObject<boolean>,
) {
  lastContentRef.current = content;
  pendingContentRef.current = null;
  writingRef.current = true;

  terminal.write('\x1b[3J\x1b[H\x1b[J' + content, () => {
    terminal.scrollToBottom();
    writingRef.current = false;

    // Flush any content that arrived while this write was in progress
    const pending = pendingContentRef.current;
    if (pending !== null && pending !== lastContentRef.current) {
      doTerminalWrite(terminal, pending, lastContentRef, pendingContentRef, writingRef);
    }
  });
}

// ── Hook ──

export function useXterm({
  fontSize,
  onInput,
  onResize,
}: UseXtermParams): UseXtermReturn {
  const containerRef = useRef<HTMLDivElement>(null!);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const lastContentRef = useRef<string>('');
  const pendingContentRef = useRef<string | null>(null);
  const writingRef = useRef(false); // true while we're writing content (ignore scroll events)
  const onInputRef = useRef(onInput);
  onInputRef.current = onInput;
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
      scrollback: 5000,
      convertEol: true,
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

    // Store refs
    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;

    // Initial fit - defer to ensure container has dimensions
    // Use requestAnimationFrame to wait for layout
    requestAnimationFrame(() => {
      try {
        // Check if container has dimensions before fitting
        const proposedDims = fitAddon.proposeDimensions();
        if (!proposedDims) {
          console.warn('Container has no dimensions yet, skipping fit');
          return;
        }
        fitAddon.fit();
        const dims = { cols: terminal.cols, rows: terminal.rows };
        setDimensions(dims);
        onResize(dims.cols, dims.rows);
      } catch (e) {
        console.error('Initial fit failed:', e);
      }
    });

    // Handle keyboard input (desktop only — mobile uses a separate input bar)
    // Filter out mouse event sequences — xterm.js sends these when the user
    // clicks the terminal, and tmux/Claude interprets the encoded coordinates
    // as literal text (e.g. "8" from coordinate bytes).
    const inputDisposable = terminal.onData((data) => {
      // DEBUG: log raw data as hex to diagnose ghost "8" input
      const hex = Array.from(data).map(c => c.charCodeAt(0).toString(16).padStart(2, '0')).join(' ');
      console.log(`[xterm onData] len=${data.length} hex=[${hex}] repr=${JSON.stringify(data)}`);

      // X10/Normal mouse: \x1b[M followed by 3 bytes (button, x, y)
      if (data.length >= 3 && data.startsWith('\x1b[M')) return;
      // SGR mouse: \x1b[< ... M or \x1b[< ... m (press/release)
      if (/^\x1b\[<[\d;]*[Mm]$/.test(data)) return;
      // urxvt mouse: \x1b[ digits ; digits ; digits M
      if (/^\x1b\[\d+;\d+;\d+M$/.test(data)) return;
      onInputRef.current(data);
    });

    // When user scrolls back to bottom, flush any pending (deferred) content
    const scrollDisposable = terminal.onScroll(() => {
      // Ignore scroll events caused by our own writes
      if (writingRef.current) return;

      const viewport = terminal.buffer.active;
      const isAtBottom = viewport.baseY <= viewport.viewportY;

      if (isAtBottom && pendingContentRef.current !== null) {
        doTerminalWrite(terminal, pendingContentRef.current, lastContentRef, pendingContentRef, writingRef);
      }
    });

    // Cleanup
    return () => {
      inputDisposable.dispose();
      scrollDisposable.dispose();
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
      onResize(dims.cols, dims.rows);
    } catch (e) {
      console.error('Font size change fit failed:', e);
    }
  }, [fontSize, onResize]);

  // Handle container resize — only refit when WIDTH changes.
  // Height-only changes (mobile keyboard open/close) should not refit,
  // because refitting triggers a full terminal clear + rewrite which
  // causes a visible jump. The terminal scrolls naturally instead.
  useEffect(() => {
    const container = containerRef.current;
    const fitAddon = fitAddonRef.current;
    const terminal = terminalRef.current;
    if (!container || !fitAddon || !terminal) return;

    let lastWidth = container.clientWidth;

    const observer = new ResizeObserver(() => {
      requestAnimationFrame(() => {
        const currentWidth = container.clientWidth;
        // Skip height-only changes (keyboard open/close)
        if (currentWidth === lastWidth) return;
        lastWidth = currentWidth;

        try {
          const proposedDims = fitAddon.proposeDimensions();
          if (!proposedDims) return;
          fitAddon.fit();
          const dims = { cols: terminal.cols, rows: terminal.rows };
          setDimensions(dims);
          onResize(dims.cols, dims.rows);
        } catch (e) {
          console.error('Resize fit failed:', e);
        }
      });
    });

    observer.observe(container);

    return () => {
      observer.disconnect();
    };
  }, [onResize]);

  // Write content to terminal (full screen rewrite)
  // If user has scrolled up, defer the update until they scroll back to bottom
  const write = useCallback((content: string) => {
    const terminal = terminalRef.current;
    if (!terminal) return;

    // Skip if content unchanged
    if (content === lastContentRef.current) return;

    // If a write is in progress, queue this content — it will be flushed
    // when the current write's callback fires. This prevents checking
    // isAtBottom during a write (when the buffer is in an intermediate
    // state and baseY > viewportY even though the user didn't scroll).
    if (writingRef.current) {
      pendingContentRef.current = content;
      return;
    }

    // Check actual scroll position — if user scrolled up, defer
    const viewport = terminal.buffer.active;
    const isAtBottom = viewport.baseY <= viewport.viewportY;

    if (!isAtBottom) {
      pendingContentRef.current = content;
      return;
    }

    doTerminalWrite(terminal, content, lastContentRef, pendingContentRef, writingRef);
  }, []);

  // Reset internal write state — unsticks writingRef and clears content tracking
  // so the next write() call will force a full rewrite
  const resetWriteState = useCallback(() => {
    writingRef.current = false;
    lastContentRef.current = '';
    pendingContentRef.current = null;
  }, []);

  // Focus terminal
  const focus = useCallback(() => {
    terminalRef.current?.focus();
  }, []);

  // Blur terminal
  const blur = useCallback(() => {
    terminalRef.current?.blur();
  }, []);

  // Scroll by N lines (positive = down, negative = up)
  const scrollLines = useCallback((n: number) => {
    terminalRef.current?.scrollLines(n);
  }, []);

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
    write,
    resetWriteState,
    focus,
    blur,
    scrollLines,
    getTextContent,
    dimensions,
  };
}
