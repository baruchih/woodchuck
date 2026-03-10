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
  const onInputRef = useRef(onInput);
  onInputRef.current = onInput;
  const composingRef = useRef(false);
  const skipNextDataRef = useRef(false);
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
      scrollback: 1000,
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

    // Handle keyboard input (use ref to always call latest onInput)
    // Suppress onData during IME/autocomplete composition to prevent duplication
    const inputDisposable = terminal.onData((data) => {
      if (composingRef.current) return;
      // Skip exactly one onData after compositionend (xterm echoes the composed text)
      if (skipNextDataRef.current) {
        skipNextDataRef.current = false;
        return;
      }
      onInputRef.current(data);
    });

    // Track mobile keyboard composition (autocomplete/prediction)
    // xterm uses an internal textarea — listen for composition events on it
    const xtermTextarea = container.querySelector('textarea');
    const handleCompositionStart = () => {
      composingRef.current = true;
    };
    const handleCompositionEnd = (e: CompositionEvent) => {
      composingRef.current = false;
      // Send the final composed text (the completed word)
      if (e.data) {
        onInputRef.current(e.data);
        // xterm fires onData right after compositionend with the same text.
        // Skip exactly that one event to prevent duplication.
        skipNextDataRef.current = true;
      }
    };
    if (xtermTextarea) {
      xtermTextarea.addEventListener('compositionstart', handleCompositionStart);
      xtermTextarea.addEventListener('compositionend', handleCompositionEnd);
    }

    // Cleanup
    return () => {
      inputDisposable.dispose();
      if (xtermTextarea) {
        xtermTextarea.removeEventListener('compositionstart', handleCompositionStart);
        xtermTextarea.removeEventListener('compositionend', handleCompositionEnd);
      }
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
  const write = useCallback((content: string) => {
    const terminal = terminalRef.current;
    if (!terminal) return;

    // Skip if content unchanged
    if (content === lastContentRef.current) return;
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
