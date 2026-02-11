import { describe, it, expect } from 'vitest';
import { detectContextActions } from '../attention';

describe('detectContextActions', () => {
  // ── Empty / no-match ──

  it('returns [] for empty string', () => {
    expect(detectContextActions('')).toEqual([]);
  });

  it('returns [] for whitespace-only', () => {
    expect(detectContextActions('   \n  \n  ')).toEqual([]);
  });

  it('returns [] when no patterns match', () => {
    expect(detectContextActions('Hello world\nJust some output')).toEqual([]);
  });

  // ── Priority 1: Y/N prompts ──

  it('detects (y/n) prompt', () => {
    const result = detectContextActions('Do you want to continue? (y/n)');
    expect(result).toEqual([
      { label: 'Y', key: 'y', variant: 'primary' },
      { label: 'N', key: 'n', variant: 'danger' },
    ]);
  });

  it('detects [y/n] prompt', () => {
    const result = detectContextActions('Overwrite file? [y/n]');
    expect(result).toEqual([
      { label: 'Y', key: 'y', variant: 'primary' },
      { label: 'N', key: 'n', variant: 'danger' },
    ]);
  });

  it('detects (Y)es (N)o prompt', () => {
    const result = detectContextActions('Proceed? (Y)es / (N)o');
    expect(result).toEqual([
      { label: 'Y', key: 'y', variant: 'primary' },
      { label: 'N', key: 'n', variant: 'danger' },
    ]);
  });

  it('detects [yes/no] prompt', () => {
    const result = detectContextActions('Are you sure? [yes/no]');
    expect(result).toEqual([
      { label: 'Y', key: 'y', variant: 'primary' },
      { label: 'N', key: 'n', variant: 'danger' },
    ]);
  });

  it('detects y/n in last 10 lines', () => {
    const lines = Array(20).fill('normal output');
    lines.push('Continue? (y/n)');
    const result = detectContextActions(lines.join('\n'));
    expect(result).toEqual([
      { label: 'Y', key: 'y', variant: 'primary' },
      { label: 'N', key: 'n', variant: 'danger' },
    ]);
  });

  it('returns [] when y/n is only in earlier lines beyond the window', () => {
    const lines = ['Continue? (y/n)'];
    for (let i = 0; i < 15; i++) {
      lines.push('normal output line ' + i);
    }
    const result = detectContextActions(lines.join('\n'));
    expect(result).toEqual([]);
  });

  // ── Priority 2: Approve/Deny ──

  it('detects approve + deny keywords', () => {
    const result = detectContextActions('You can approve or deny this request');
    expect(result).toEqual([
      { label: 'Approve', key: 'y', variant: 'primary' },
      { label: 'Deny', key: 'n', variant: 'danger' },
    ]);
  });

  it('detects [approve] [deny] brackets', () => {
    const result = detectContextActions('Choose: [approve] or [deny]');
    expect(result).toEqual([
      { label: 'Approve', key: 'y', variant: 'primary' },
      { label: 'Deny', key: 'n', variant: 'danger' },
    ]);
  });

  it('detects [allow] [reject] brackets', () => {
    const result = detectContextActions('Select: [allow] or [reject]');
    expect(result).toEqual([
      { label: 'Approve', key: 'y', variant: 'primary' },
      { label: 'Deny', key: 'n', variant: 'danger' },
    ]);
  });

  it('does not trigger approve/deny when only approve is present', () => {
    const result = detectContextActions('Click approve to continue');
    expect(result).toEqual([]);
  });

  // ── Priority 3: Numbered options ──

  it('detects numbered options with dots', () => {
    const result = detectContextActions('1. First\n2. Second\n3. Third');
    expect(result).toEqual([
      { label: '1', key: '1', variant: 'ghost' },
      { label: '2', key: '2', variant: 'ghost' },
      { label: '3', key: '3', variant: 'ghost' },
    ]);
  });

  it('detects numbered options with parentheses', () => {
    const result = detectContextActions('1) Option A\n2) Option B');
    expect(result).toEqual([
      { label: '1', key: '1', variant: 'ghost' },
      { label: '2', key: '2', variant: 'ghost' },
    ]);
  });

  it('detects numbered options with brackets', () => {
    const result = detectContextActions('1] Foo\n2] Bar\n3] Baz\n4] Qux');
    expect(result).toEqual([
      { label: '1', key: '1', variant: 'ghost' },
      { label: '2', key: '2', variant: 'ghost' },
      { label: '3', key: '3', variant: 'ghost' },
      { label: '4', key: '4', variant: 'ghost' },
    ]);
  });

  it('detects numbered options with colons', () => {
    const result = detectContextActions('1: Alpha\n2: Beta');
    expect(result).toEqual([
      { label: '1', key: '1', variant: 'ghost' },
      { label: '2', key: '2', variant: 'ghost' },
    ]);
  });

  it('detects digits 5-9', () => {
    const result = detectContextActions('5. Fifth option\n6. Sixth option');
    expect(result).toEqual([
      { label: '5', key: '5', variant: 'ghost' },
      { label: '6', key: '6', variant: 'ghost' },
    ]);
  });

  it('deduplicates repeated digits', () => {
    const result = detectContextActions('1. First\n1. First again\n2. Second');
    expect(result).toEqual([
      { label: '1', key: '1', variant: 'ghost' },
      { label: '2', key: '2', variant: 'ghost' },
    ]);
  });

  it('detects parenthesized numbers like (1) Foo', () => {
    const result = detectContextActions('(1) Option A\n(2) Option B\n(3) Option C');
    expect(result).toEqual([
      { label: '1', key: '1', variant: 'ghost' },
      { label: '2', key: '2', variant: 'ghost' },
      { label: '3', key: '3', variant: 'ghost' },
    ]);
  });

  it('detects numbered options with dash separator', () => {
    const result = detectContextActions('1 - Alpha\n2 - Beta\n3 - Gamma');
    expect(result).toEqual([
      { label: '1', key: '1', variant: 'ghost' },
      { label: '2', key: '2', variant: 'ghost' },
      { label: '3', key: '3', variant: 'ghost' },
    ]);
  });

  it('detects all 4 options even with header + prompt lines', () => {
    const content = [
      'Choose an option:',
      '1. First option',
      '2. Second option',
      '3. Third option',
      '4. Fourth option',
      'Your choice:',
    ].join('\n');
    const result = detectContextActions(content);
    expect(result).toEqual([
      { label: '1', key: '1', variant: 'ghost' },
      { label: '2', key: '2', variant: 'ghost' },
      { label: '3', key: '3', variant: 'ghost' },
      { label: '4', key: '4', variant: 'ghost' },
    ]);
  });

  it('handles ❯ cursor prefix on selected option', () => {
    const content = [
      '❯ 1. Explore codebase',
      '  2. Make changes',
      '  3. Run commands',
    ].join('\n');
    const result = detectContextActions(content);
    expect(result).toEqual([
      { label: '1', key: '1', variant: 'ghost' },
      { label: '2', key: '2', variant: 'ghost' },
      { label: '3', key: '3', variant: 'ghost' },
    ]);
  });

  it('handles Claude Code full menu with 6 options', () => {
    const content = [
      'What would you like to do?',
      '❯ 1. Explore codebase',
      '  2. Make changes',
      '  3. Run commands',
      '  4. Get help',
      '  5. Type something.',
      '  6. Chat about this',
      'Enter to select',
    ].join('\n');
    const result = detectContextActions(content);
    expect(result).toEqual([
      { label: '1', key: '1', variant: 'ghost' },
      { label: '2', key: '2', variant: 'ghost' },
      { label: '3', key: '3', variant: 'ghost' },
      { label: '4', key: '4', variant: 'ghost' },
      { label: '5', key: '5', variant: 'ghost' },
      { label: '6', key: '6', variant: 'ghost' },
    ]);
  });

  it('finds all options when descriptions push earlier ones beyond the 10-line window', () => {
    const content = [
      'What would you like to do?',
      '❯ 1. Explore codebase',
      '     Browse and understand the project structure and code',
      '  2. Write code',
      '     Implement new features or make changes',
      '  3. Fix a bug',
      '     Debug and resolve an issue in the code',
      '  4. Run commands',
      '     Execute shell commands, run tests, or manage dependencies',
      '  5. Type something.',
      '────────────────',
      '  6. Chat about this',
      '',
      'Enter to select · ↑/↓ to navigate · Esc to cancel',
    ].join('\n');
    const result = detectContextActions(content);
    expect(result).toEqual([
      { label: '1', key: '1', variant: 'ghost' },
      { label: '2', key: '2', variant: 'ghost' },
      { label: '3', key: '3', variant: 'ghost' },
      { label: '4', key: '4', variant: 'ghost' },
      { label: '5', key: '5', variant: 'ghost' },
      { label: '6', key: '6', variant: 'ghost' },
    ]);
  });

  // ── Priority 4: Navigation / pager ──

  it('detects --More--', () => {
    const result = detectContextActions('content here\n--More--');
    expect(result).toEqual([
      { label: 'Up', key: 'Up', variant: 'ghost' },
      { label: 'Down', key: 'Down', variant: 'ghost' },
    ]);
  });

  it('detects (END)', () => {
    const result = detectContextActions('content here\n(END)');
    expect(result).toEqual([
      { label: 'Up', key: 'Up', variant: 'ghost' },
      { label: 'Down', key: 'Down', variant: 'ghost' },
    ]);
  });

  it('detects scroll keyword', () => {
    const result = detectContextActions('Use arrow keys to scroll');
    expect(result).toEqual([
      { label: 'Up', key: 'Up', variant: 'ghost' },
      { label: 'Down', key: 'Down', variant: 'ghost' },
    ]);
  });

  it('detects "lines N-M" pattern', () => {
    const result = detectContextActions('lines 1-20 of 100');
    expect(result).toEqual([
      { label: 'Up', key: 'Up', variant: 'ghost' },
      { label: 'Down', key: 'Down', variant: 'ghost' },
    ]);
  });

  // ── ANSI stripping ──

  it('strips ANSI codes before matching', () => {
    const ansi = '\x1b[32mContinue?\x1b[0m (y/n)';
    const result = detectContextActions(ansi);
    expect(result).toEqual([
      { label: 'Y', key: 'y', variant: 'primary' },
      { label: 'N', key: 'n', variant: 'danger' },
    ]);
  });

  it('strips ANSI from numbered options', () => {
    const ansi = '\x1b[1m1.\x1b[0m First\n\x1b[1m2.\x1b[0m Second';
    const result = detectContextActions(ansi);
    expect(result).toEqual([
      { label: '1', key: '1', variant: 'ghost' },
      { label: '2', key: '2', variant: 'ghost' },
    ]);
  });

  // ── Priority ordering (first-match-wins) ──

  it('Y/N takes priority over approve/deny', () => {
    const result = detectContextActions('Approve or deny? (y/n)');
    expect(result).toEqual([
      { label: 'Y', key: 'y', variant: 'primary' },
      { label: 'N', key: 'n', variant: 'danger' },
    ]);
  });

  it('approve/deny takes priority over numbered options', () => {
    const result = detectContextActions('1. approve\n2. deny');
    expect(result).toEqual([
      { label: 'Approve', key: 'y', variant: 'primary' },
      { label: 'Deny', key: 'n', variant: 'danger' },
    ]);
  });
});
