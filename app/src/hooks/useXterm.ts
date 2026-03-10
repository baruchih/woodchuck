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
  focus: () => void;
  blur: () => void;
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
  const userScrolledRef = useRef(false);
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
    const inputDisposable = terminal.onData((data) => {
      onInputRef.current(data);
    });

    // Track user scroll position to avoid overwriting while scrolled up
    const scrollDisposable = terminal.onScroll(() => {
      const viewport = terminal.buffer.active;
      const isAtBottom = viewport.baseY <= viewport.viewportY;
      userScrolledRef.current = !isAtBottom;

      // If user scrolled back to bottom, flush any pending content
      if (isAtBottom && pendingContentRef.current !== null) {
        const pending = pendingContentRef.current;
        pendingContentRef.current = null;
        lastContentRef.current = pending;
        terminal.write('\x1b[2J\x1b[H' + pending);
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

    // If user is scrolled up, stash the content for later
    if (userScrolledRef.current) {
      pendingContentRef.current = content;
      return;
    }

    lastContentRef.current = content;

    // Clear screen and cursor home, then write full content
    terminal.write('\x1b[2J\x1b[H' + content);
  }, []);

  // Focus terminal
  const focus = useCallback(() => {
    terminalRef.current?.focus();
  }, []);

  // Blur terminal
  const blur = useCallback(() => {
    terminalRef.current?.blur();
  }, []);

  return {
    containerRef,
    write,
    focus,
    blur,
    dimensions,
  };
}
