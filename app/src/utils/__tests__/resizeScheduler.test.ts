import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createResizeScheduler, type GridSize } from '../resizeScheduler';

describe('createResizeScheduler', () => {
  let sent: GridSize[];
  beforeEach(() => {
    vi.useFakeTimers();
    sent = [];
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const make = () => createResizeScheduler((s) => sent.push(s), 250);

  it('sends one resize after a burst settles, with the final size', () => {
    const s = make();
    s.request({ cols: 40, rows: 30 });
    vi.advanceTimersByTime(100);
    s.request({ cols: 38, rows: 40 });
    vi.advanceTimersByTime(100);
    s.request({ cols: 38, rows: 45 });
    expect(sent).toEqual([]);
    vi.advanceTimersByTime(250);
    expect(sent).toEqual([{ cols: 38, rows: 45 }]);
  });

  it('skips a size this view already sent', () => {
    const s = make();
    s.request({ cols: 120, rows: 40 });
    vi.advanceTimersByTime(250);
    s.request({ cols: 120, rows: 40 });
    vi.advanceTimersByTime(250);
    expect(sent).toEqual([{ cols: 120, rows: 40 }]);
  });

  it('sends an unchanged size when forced (reclaiming after another device resized)', () => {
    const s = make();
    s.request({ cols: 120, rows: 40 });
    vi.advanceTimersByTime(250);
    s.request({ cols: 120, rows: 40 }, { force: true });
    vi.advanceTimersByTime(250);
    expect(sent).toEqual([{ cols: 120, rows: 40 }, { cols: 120, rows: 40 }]);
  });

  it('keeps a force through a burst', () => {
    const s = make();
    s.request({ cols: 120, rows: 40 });
    vi.advanceTimersByTime(250);
    s.request({ cols: 120, rows: 40 }, { force: true });
    s.request({ cols: 120, rows: 40 });
    vi.advanceTimersByTime(250);
    expect(sent).toHaveLength(2);
  });

  it('ignores transient zero-size layouts', () => {
    const s = make();
    s.request({ cols: 0, rows: 24 });
    s.request({ cols: 80, rows: 1 });
    vi.advanceTimersByTime(250);
    expect(sent).toEqual([]);
  });

  it('sends nothing after dispose', () => {
    const s = make();
    s.request({ cols: 80, rows: 24 });
    s.dispose();
    vi.advanceTimersByTime(250);
    expect(sent).toEqual([]);
  });
});
