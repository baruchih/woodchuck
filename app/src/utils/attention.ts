/**
 * Attention detection utility.
 *
 * Scans the last few non-empty lines of terminal output for patterns
 * that indicate Claude (or the shell) is waiting for user input.
 */

import type { ContextAction } from '../types';

const ATTENTION_PATTERNS: RegExp[] = [
  // Y/N and choice prompts
  /\(Y\)es/i,                       // (Y)es prompt
  /\(y\/n\)/i,                      // (y/n) prompt
  /\[Y\/n\]/i,                      // [Y/n] prompt
  /\[yes\/no\]/i,                   // [yes/no] prompt
  /\[yes\]/i,                       // [yes] prompt
  /\[no\]/i,                        // [no] prompt

  // Shell/command prompts waiting for input
  /\$ $/,                            // shell prompt ending with "$ "
  /> $/,                             // command prompt ending with "> "

  // Explicit action prompts
  /press enter/i,                    // "press enter" text
  /Do you want to proceed/i,        // proceed prompt
  /Do you want to/i,                // generic "do you want" prompt
  /trust this/i,                    // trust prompt
  /esc to cancel/i,                 // esc to cancel prompt

  // Permission prompts with question-like context
  /\b(?:approve|deny|allow|reject|permission)\b.*\?\s*$/im, // these words followed by "?" at end of line
  /\b(?:approve|deny|allow|reject)\b.*\(.*\)/i,             // these words with a parenthesized choice e.g. "(y/n)"
  /\[(?:approve|deny|allow|reject)\]/i,                      // bracketed choices like [approve] [deny]
];

/**
 * Checks the last 5 non-empty lines of terminal content for patterns
 * that indicate the process is waiting for user input.
 *
 * @param content - The full terminal pane content
 * @returns true if attention-needing patterns are detected
 */
export function detectAttention(content: string): boolean {
  if (!content || !content.trim()) {
    return false;
  }

  const lines = content.split('\n');
  const nonEmptyLines = lines.filter((line) => line.trim().length > 0);
  const lastLines = nonEmptyLines.slice(-5);

  if (lastLines.length === 0) {
    return false;
  }

  const lastLinesText = lastLines.join('\n');

  for (const pattern of ATTENTION_PATTERNS) {
    if (pattern.test(lastLinesText)) {
      return true;
    }
  }

  return false;
}

// ── Context action detection ──

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
}

/**
 * Scans the last 10 non-empty lines of terminal content for contextual
 * patterns and returns a list of suggested quick-actions for the outer
 * ring of the radial menu.
 *
 * Uses a 10-line window (vs 5 for detectAttention) because numbered
 * option menus can span a header + several options + a prompt line.
 *
 * First-match-wins: the highest-priority pattern that matches determines
 * the returned actions.
 */
export function detectContextActions(content: string): ContextAction[] {
  if (!content || !content.trim()) {
    return [];
  }

  const cleaned = stripAnsi(content);
  const lines = cleaned.split('\n');
  const nonEmptyLines = lines.filter((line) => line.trim().length > 0);
  const lastLines = nonEmptyLines.slice(-10);

  if (lastLines.length === 0) {
    return [];
  }

  const text = lastLines.join('\n');

  // Priority 1 — Y/N prompts
  if (
    /\(y\/n\)/i.test(text) ||
    /\[y\/n\]/i.test(text) ||
    /\(Y\)es.*\(N\)o/i.test(text) ||
    /\[yes\/no\]/i.test(text)
  ) {
    return [
      { label: 'Y', key: 'y', variant: 'primary' },
      { label: 'N', key: 'n', variant: 'danger' },
    ];
  }

  // Priority 2 — Approve/Deny prompts
  if (
    (/\bapprove\b/i.test(text) && /\bdeny\b/i.test(text)) ||
    /\[(approve|allow)\].*\[(deny|reject)\]/i.test(text)
  ) {
    return [
      { label: 'Approve', key: 'y', variant: 'primary' },
      { label: 'Deny', key: 'n', variant: 'danger' },
    ];
  }

  // Priority 3 — Numbered options (1-9)
  // Handles: "1. Foo", "1) Foo", "1] Foo", "1: Foo", "(1) Foo", "1 - Foo"
  // Also handles cursor prefixes like "❯ 1. Foo" or "> 1. Foo"
  // IMPORTANT: Only scan lastLines (10-line window) to avoid picking up
  // line numbers from earlier content (e.g., "62 - [ ] cargo test")
  const numberLineRe = /^\s*(?:[❯>›»]\s*)?(?:\(?(\d)\)?[.)\]:\s-]+\S)/;
  const numberDetectRe = new RegExp(numberLineRe.source, 'm');
  if (numberDetectRe.test(text)) {
    const digits = new Set<string>();
    for (const line of lastLines) {
      const match = line.match(numberLineRe);
      if (match && match[1]) {
        digits.add(match[1]);
      }
    }
    if (digits.size > 0) {
      return Array.from(digits)
        .sort()
        .map((d) => ({ label: d, key: d, variant: 'ghost' as const }));
    }
  }

  // Priority 4 — Navigation / pager
  if (
    /--more--/i.test(text) ||
    /\(END\)/.test(text) ||
    /\bscroll\b/i.test(text) ||
    /lines \d+-\d+/i.test(text)
  ) {
    return [
      { label: 'Up', key: 'Up', variant: 'ghost' },
      { label: 'Down', key: 'Down', variant: 'ghost' },
    ];
  }

  return [];
}
