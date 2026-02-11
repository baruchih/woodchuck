//! Output parsing and status detection
//!
//! Analyzes terminal output to determine Claude's current status.

use super::types::SessionStatus;

/// Strip ANSI escape sequences from a string.
///
/// Handles standard CSI sequences: ESC `[` (params) (letter).
fn strip_ansi(text: &str) -> String {
    let mut result = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();

    while let Some(ch) = chars.next() {
        if ch == '\x1b' {
            // Check for CSI sequence: ESC [
            if chars.peek() == Some(&'[') {
                chars.next(); // consume '['
                // Skip parameter bytes (digits, semicolons) and the final letter
                while let Some(&c) = chars.peek() {
                    if c.is_ascii_alphabetic() {
                        chars.next(); // consume the final letter
                        break;
                    }
                    chars.next(); // consume parameter byte
                }
            }
            // else: bare ESC — skip it
        } else {
            result.push(ch);
        }
    }

    result
}

/// Whether a line is Claude Code UI chrome (not real content).
///
/// Claude Code renders decorative elements around the prompt:
/// - Horizontal rules (`────`)
/// - Help hints (`? for shortcuts`, `esc to interrupt`, etc.)
/// - Autocomplete hints (`⏵⏵ accept edits on`)
/// - Keyboard shortcut hints (`ctrl+t to hide tasks`)
fn is_ui_chrome(line: &str) -> bool {
    let trimmed = line.trim();

    // Empty lines
    if trimmed.is_empty() {
        return true;
    }

    // Horizontal rule (box-drawing chars only)
    if trimmed.chars().all(|c| c == '─' || c == '━' || c == '-') {
        return true;
    }

    // Help/shortcut hints at start of line
    if trimmed.starts_with("? for shortcuts")
        || trimmed.starts_with("?") && trimmed.len() < 30  // Short ? lines are hints
        || trimmed.starts_with("esc to")
        || trimmed.starts_with("ctrl+")
        || trimmed.starts_with("shift+")
        || trimmed.starts_with("tab to")
    {
        return true;
    }

    // Autocomplete/edit acceptance hints (⏵⏵ symbol)
    if trimmed.starts_with("⏵⏵") || trimmed.contains("⏵⏵") {
        return true;
    }

    // Keyboard hints in parentheses at end
    if trimmed.ends_with("to hide tasks")
        || trimmed.ends_with("to cycle)")
        || trimmed.ends_with("to expand)")
    {
        return true;
    }

    // Context usage indicator (can wrap across lines)
    // e.g., "Context left until auto-compact: 6%"
    if trimmed.starts_with("Context left")
        || trimmed == "until"
        || trimmed.starts_with("auto-compact")
    {
        return true;
    }

    // Percentage-only lines (wrapped context indicators like "6%")
    if trimmed.len() <= 4 && trimmed.ends_with('%') {
        return true;
    }

    false
}

/// Whether a line looks like an interactive prompt.
fn is_prompt_line(line: &str) -> bool {
    let trimmed = line.trim();
    // ASCII `>` prompt (exact or followed by space only)
    trimmed == ">"
        || trimmed == "> "
        // Unicode `❯` prompt (Claude Code uses U+276F)
        // Match any line starting with ❯ — this catches autocomplete suggestions
        // like "❯ Try..." which appear when Claude is idle at the prompt
        || trimmed.starts_with('❯')
        // Shell $ prompt patterns
        || trimmed == "$"
        || trimmed.ends_with("$ ")
        || trimmed.ends_with(":~$")
        || trimmed.ends_with(" $")
        || trimmed.ends_with("\t$")
}

/// Check whether the terminal output ends at an interactive prompt.
///
/// Skips Claude Code UI chrome (horizontal rules, help hints) then checks
/// whether the last real content line is a prompt.
fn is_at_prompt(output: &str) -> bool {
    let clean = strip_ansi(output);
    let last_real_line = clean
        .lines()
        .rev()
        .filter(|l| !l.trim().is_empty())
        .find(|l| !is_ui_chrome(l));

    match last_real_line {
        None => false,
        Some(line) => is_prompt_line(line),
    }
}

/// Check if Claude Code is actively working (tool running, thinking, etc).
///
/// When Claude is working, it shows "esc to interrupt" in the UI chrome.
/// When Claude is resting/idle, this option is NOT shown.
/// This is a stable functional indicator - you can only interrupt active work.
fn is_interruptible(output: &str) -> bool {
    let clean = strip_ansi(output);
    clean.contains("esc to interrupt")
}

/// Detect the current status of Claude based on terminal output
///
/// Analyzes terminal output to determine what Claude is doing.
/// Uses a simple 4-state model checked in priority order:
///
/// 1. Error (last 5 lines) -- error patterns
/// 2. NeedsInput (last 5 lines) -- waiting/prompt patterns
/// 3. Working -- "esc to interrupt" shown (Claude is actively working)
/// 4. Resting -- at a `>` or `$` prompt
/// 5. Working -- any non-empty output (fallback)
/// 6. Resting -- fallback for empty output
pub fn detect_status(output: &str) -> SessionStatus {
    // Strip ANSI codes first so pattern matching works correctly
    let clean = strip_ansi(output);

    // Last 5 non-empty, non-chrome lines for immediate analysis
    let lines_5: Vec<&str> = clean
        .lines()
        .rev()
        .filter(|l| !l.trim().is_empty() && !is_ui_chrome(l))
        .take(5)
        .collect();
    let very_recent = lines_5.join("\n").to_lowercase();

    // 1. Error patterns -- very_recent (5 lines)
    if contains_any(&very_recent, &[
        "error:",
        "error[",
        "failed:",
        "exception:",
        "panic:",
        "fatal:",
        "cannot find",
        "command not found",
    ]) {
        return SessionStatus::Error;
    }

    // 2. NeedsInput patterns -- very_recent (5 lines)
    if contains_any(&very_recent, &[
        "[y/n]",
        "[yes/no]",
        "proceed?",
        "confirm?",
        "continue?",
        "(y/n)",
        "enter to",
        "press enter",
        "waiting for input",
        "do you want",
        "would you like",
        "trust this",
        "esc to cancel",
        // Claude Code selection menus
        "enter to select",
        "↑/↓ to navigate",
        "to navigate",
    ]) {
        return SessionStatus::NeedsInput;
    }

    // 3. Working -- Claude shows "esc to interrupt" when actively working
    // This is a stable UI indicator (not a theme word)
    if is_interruptible(output) {
        return SessionStatus::Working;
    }

    // 4. Resting -- at a prompt
    if is_at_prompt(output) {
        return SessionStatus::Resting;
    }

    // 4. Working -- any non-empty output means agent is active
    if !output.trim().is_empty() {
        return SessionStatus::Working;
    }

    // 5. Resting -- fallback for empty output
    SessionStatus::Resting
}

/// Check if text contains any of the patterns
fn contains_any(text: &str, patterns: &[&str]) -> bool {
    patterns.iter().any(|p| text.contains(p))
}

/// Calculate a simple hash for change detection
pub fn calculate_hash(content: &str) -> u64 {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};

    let mut hasher = DefaultHasher::new();
    content.hash(&mut hasher);
    hasher.finish()
}

/// Extract new content by comparing old and new output
///
/// Returns the lines that are new (not in the previous output).
pub fn diff_output(old: &str, new: &str) -> String {
    // Simple approach: if new is longer, return the new suffix
    if new.len() > old.len() && new.starts_with(old) {
        return new[old.len()..].trim_start_matches('\n').to_string();
    }

    // If they're different, find where they diverge
    let old_lines: Vec<&str> = old.lines().collect();
    let new_lines: Vec<&str> = new.lines().collect();

    // Find the first line that differs
    let common_prefix = old_lines
        .iter()
        .zip(new_lines.iter())
        .take_while(|(a, b)| a == b)
        .count();

    // Return lines from the divergence point
    new_lines[common_prefix..].join("\n")
}

// =============================================================================
// Unit Tests
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_detect_error_status() {
        let output = "Some output\nerror: cannot find module";
        assert_eq!(detect_status(output), SessionStatus::Error);
    }

    #[test]
    fn test_detect_error_patterns() {
        assert_eq!(detect_status("panic: something broke"), SessionStatus::Error);
        assert_eq!(detect_status("fatal: not a git repo"), SessionStatus::Error);
        assert_eq!(detect_status("error[E0308]: mismatched types"), SessionStatus::Error);
        assert_eq!(detect_status("command not found: foo"), SessionStatus::Error);
    }

    #[test]
    fn test_detect_needs_input_status() {
        let output = "Do you want to proceed? [y/n]";
        assert_eq!(detect_status(output), SessionStatus::NeedsInput);
    }

    #[test]
    fn test_detect_needs_input_patterns() {
        assert_eq!(detect_status("Continue? [yes/no]"), SessionStatus::NeedsInput);
        assert_eq!(detect_status("Press enter to continue"), SessionStatus::NeedsInput);
        assert_eq!(detect_status("Do you want to install?"), SessionStatus::NeedsInput);
        assert_eq!(detect_status("Would you like to proceed?"), SessionStatus::NeedsInput);
        assert_eq!(detect_status("Trust this tool? (y/n)"), SessionStatus::NeedsInput);
        assert_eq!(detect_status("Esc to cancel, Enter to confirm"), SessionStatus::NeedsInput);
    }

    #[test]
    fn test_detect_working_status() {
        let output = "Some generic output that doesn't match patterns";
        assert_eq!(detect_status(output), SessionStatus::Working);
    }

    #[test]
    fn test_detect_resting_empty() {
        let output = "";
        assert_eq!(detect_status(output), SessionStatus::Resting);
    }

    #[test]
    fn test_detect_resting_at_prompt() {
        let output = "Some previous output\nDone something\n> \n";
        assert_eq!(detect_status(output), SessionStatus::Resting);
    }

    #[test]
    fn test_detect_resting_prompt_overrides_stale_output() {
        // Old output far up, but last line is `>` prompt -> Resting
        let mut lines = vec!["some old output".to_string()];
        for i in 0..14 {
            lines.push(format!("some other output line {}", i));
        }
        lines.push("> ".to_string());
        let output = lines.join("\n");
        assert_eq!(detect_status(&output), SessionStatus::Resting);
    }

    #[test]
    fn test_detect_working_no_prompt() {
        // Non-empty output with no prompt -> Working
        let output = "Some output\nMore output\nStill going...";
        assert_eq!(detect_status(output), SessionStatus::Working);
    }

    #[test]
    fn test_detect_working_old_output_no_prompt() {
        // Generic output far from prompt -> Working
        let mut lines = vec!["first line".to_string()];
        for i in 0..24 {
            lines.push(format!("generic output line {}", i));
        }
        let output = lines.join("\n");
        assert_eq!(detect_status(&output), SessionStatus::Working);
    }

    #[test]
    fn test_detect_needs_input_overrides_prompt() {
        // NeedsInput pattern with `>` -> NeedsInput (higher priority than Resting)
        let output = "Some output\nDo you want to proceed? [y/n]\n> ";
        assert_eq!(detect_status(output), SessionStatus::NeedsInput);
    }

    #[test]
    fn test_detect_error_overrides_prompt() {
        // Error with `>` -> Error (higher priority than Resting)
        let output = "error: cannot find module\n> ";
        assert_eq!(detect_status(output), SessionStatus::Error);
    }

    #[test]
    fn test_diff_output_simple_append() {
        let old = "line1\nline2";
        let new = "line1\nline2\nline3";
        assert_eq!(diff_output(old, new), "line3");
    }

    #[test]
    fn test_calculate_hash_different() {
        let hash1 = calculate_hash("content1");
        let hash2 = calculate_hash("content2");
        assert_ne!(hash1, hash2);
    }

    #[test]
    fn test_calculate_hash_same() {
        let hash1 = calculate_hash("same content");
        let hash2 = calculate_hash("same content");
        assert_eq!(hash1, hash2);
    }

    // =========================================================================
    // Prompt detection tests
    // =========================================================================

    #[test]
    fn test_is_at_prompt_exact_chevron() {
        assert!(is_at_prompt("some output\n>"));
    }

    #[test]
    fn test_is_at_prompt_chevron_space() {
        assert!(is_at_prompt("some output\n> "));
    }

    #[test]
    fn test_is_at_prompt_shell_dollar() {
        assert!(is_at_prompt("some output\nuser@host:~$"));
    }

    #[test]
    fn test_is_at_prompt_false_for_redirect() {
        // A line where `>` appears mid-line (e.g. shell redirect) should NOT match
        let output = "some line\ncode > redirect";
        assert!(!is_at_prompt(output));
    }

    #[test]
    fn test_is_at_prompt_unicode_chevron() {
        // Claude Code uses ❯ (U+276F) as its prompt
        assert!(is_at_prompt("some output\n❯"));
    }

    #[test]
    fn test_is_at_prompt_unicode_chevron_space() {
        assert!(is_at_prompt("some output\n❯ "));
    }

    #[test]
    fn test_resting_at_unicode_prompt() {
        // Full Claude Code output ending at ❯ prompt → Resting
        let output = "Claude Code v2.1.31\nOpus 4.5\n❯ hi\n● Hi! How can I help you today?\n❯";
        assert_eq!(detect_status(output), SessionStatus::Resting);
    }

    #[test]
    fn test_resting_with_claude_code_footer() {
        // Claude Code renders UI below the prompt: separator + "? for shortcuts"
        let output = "● Hi! How can I help you today?\n────────────────────────────────────────\n❯ \n────────────────────────────────────────\n  ? for shortcuts";
        assert_eq!(detect_status(output), SessionStatus::Resting);
    }

    #[test]
    fn test_is_at_prompt_with_footer_below() {
        // Prompt detected even when UI chrome lines follow
        let output = "some output\n❯\n────────\n  ? for shortcuts";
        assert!(is_at_prompt(output));
    }

    #[test]
    fn test_working_not_resting_when_output_after_prompt() {
        // Claude is working: prompt from previous command, then active output below
        let output = "❯ do something\n● Working on it...\n  Reading file...";
        assert_eq!(detect_status(output), SessionStatus::Working);
        assert!(!is_at_prompt(output));
    }

    #[test]
    fn test_strip_ansi() {
        let input = "\x1b[32mgreen text\x1b[0m> ";
        let clean = strip_ansi(input);
        assert_eq!(clean, "green text> ");
    }

    // =========================================================================
    // UI Chrome detection tests
    // =========================================================================

    #[test]
    fn test_is_ui_chrome_horizontal_rule() {
        assert!(is_ui_chrome("────────────────────────────────────────"));
        assert!(is_ui_chrome("━━━━━━━━━━━━━━━━━━━━"));
        assert!(is_ui_chrome("----------------------------------------"));
    }

    #[test]
    fn test_is_ui_chrome_accept_edits_hint() {
        assert!(is_ui_chrome("⏵⏵ accept edits on (shift+tab to cycle) · ctrl+t to hide tasks"));
        assert!(is_ui_chrome("  ⏵⏵ accept edits on"));
    }

    #[test]
    fn test_is_ui_chrome_keyboard_hints() {
        assert!(is_ui_chrome("esc to interrupt · ctrl+t to hide tasks"));
        assert!(is_ui_chrome("ctrl+t to hide tasks"));
        assert!(is_ui_chrome("shift+tab to cycle"));
    }

    #[test]
    fn test_is_ui_chrome_shortcuts_hint() {
        assert!(is_ui_chrome("? for shortcuts"));
        assert!(is_ui_chrome("  ? for shortcuts"));
    }

    #[test]
    fn test_is_not_ui_chrome_content() {
        assert!(!is_ui_chrome("Some actual content"));
        assert!(!is_ui_chrome("❯ user command"));
        assert!(!is_ui_chrome("● Working on it..."));
        assert!(!is_ui_chrome("Do you want to proceed?"));
    }

    #[test]
    fn test_is_ui_chrome_context_indicator() {
        // Context usage indicator can wrap across multiple lines
        assert!(is_ui_chrome("Context left until auto-compact: 6%"));
        assert!(is_ui_chrome("Context left"));
        assert!(is_ui_chrome("until")); // Wrapped fragment
        assert!(is_ui_chrome("auto-compact:"));
        assert!(is_ui_chrome("auto-compact: 6%"));
        assert!(is_ui_chrome("  6%")); // Just percentage (wrapped continuation)
    }

    #[test]
    fn test_resting_with_accept_edits_hint() {
        // Real Claude Code output with ⏵⏵ hint below prompt
        let output = r#"● Done.
────────────────────────────────────────────────────────────────────────────────
❯ yes investigate and fix
────────────────────────────────────────────────────────────────────────────────
  ⏵⏵ accept edits on (shift+tab to cycle) · ctrl+t to hide tasks"#;
        assert_eq!(detect_status(output), SessionStatus::Resting);
    }

    #[test]
    fn test_resting_with_context_indicator() {
        // Real Claude Code output with wrapped context indicator below prompt
        let output = r#"✻ Cooked for 19m 11s

────────────────────────────────────────────────────────────────────────────────
❯ let's do phase 4 services - full agent flow
────────────────────────────────────────────────────────────────────────────────
  ⏵⏵ accept edits on (shift+tab to cycle) · ctrl+t to hide tasks Context left
                                                                 until
                                                                 auto-compact:
                                                                  6%"#;
        assert_eq!(detect_status(output), SessionStatus::Resting);
    }

    #[test]
    fn test_needs_input_with_menu() {
        // Claude Code permission prompt with selection menu
        let output = r#"Do you want to proceed?
❯ 1. Yes
  2. Yes, and don't ask again
  3. No

Esc to cancel · Tab to amend"#;
        assert_eq!(detect_status(output), SessionStatus::NeedsInput);
    }

    // =========================================================================
    // Working detection tests (esc to interrupt)
    // =========================================================================

    #[test]
    fn test_working_with_esc_to_interrupt() {
        // Claude is actively working - shows "esc to interrupt" in UI chrome
        let output = r#"✻ Levitating… (1m 21s · ↓ 20 tokens)

────────────────────────────────────────────────────────────────────────────────
❯
────────────────────────────────────────────────────────────────────────────────
  ⏵⏵ accept edits on (shift+tab to cycle) · esc to interrupt · ctrl+t to hide tasks"#;
        assert_eq!(detect_status(output), SessionStatus::Working);
    }

    #[test]
    fn test_resting_without_esc_to_interrupt() {
        // Claude is resting - no "esc to interrupt" in UI chrome
        let output = r#"✻ Cooked for 8m 43s

────────────────────────────────────────────────────────────────────────────────
❯ commit this
────────────────────────────────────────────────────────────────────────────────
  ⏵⏵ accept edits on (shift+tab to cycle) · ctrl+t to hide tasks"#;
        assert_eq!(detect_status(output), SessionStatus::Resting);
    }

    #[test]
    fn test_is_interruptible() {
        assert!(is_interruptible("something · esc to interrupt · something else"));
        assert!(is_interruptible("  esc to interrupt"));
        assert!(!is_interruptible("ctrl+t to hide tasks"));
        assert!(!is_interruptible("just some text"));
    }
}
