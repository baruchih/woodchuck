export interface GridSize {
  cols: number;
  rows: number;
}

export interface ResizeScheduler {
  /** Ask to resize the session. `force` sends even if unchanged (reclaiming the size). */
  request: (size: GridSize, opts?: { force?: boolean }) => void;
  dispose: () => void;
}

interface Timers {
  set: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clear: (id: ReturnType<typeof setTimeout>) => void;
}

const defaultTimers: Timers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (id) => clearTimeout(id),
};

/**
 * Coalesce terminal resizes into one request once the layout has settled.
 * Every session resize makes the app redraw, so bursts (initial fit, font load,
 * mobile keyboard, rotation) should cost one resize, and a size this view already
 * sent costs none — unless forced, which lets a returning device take the size back.
 */
export function createResizeScheduler(
  send: (size: GridSize) => void,
  delayMs = 250,
  timers: Timers = defaultTimers,
): ResizeScheduler {
  let pending: GridSize | null = null;
  let force = false;
  let last: GridSize | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const flush = () => {
    timer = null;
    const size = pending;
    pending = null;
    const forced = force;
    force = false;
    if (!size) return;
    if (!forced && last && last.cols === size.cols && last.rows === size.rows) return;
    last = size;
    send(size);
  };

  return {
    request(size, opts) {
      // Transient layouts (hidden or zero-width containers) aren't real sizes
      if (size.cols < 2 || size.rows < 2) return;
      pending = { cols: size.cols, rows: size.rows };
      force = force || !!opts?.force;
      if (timer !== null) timers.clear(timer);
      timer = timers.set(flush, delayMs);
    },
    dispose() {
      if (timer !== null) timers.clear(timer);
      timer = null;
      pending = null;
    },
  };
}
