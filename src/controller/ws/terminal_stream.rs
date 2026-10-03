//! Live terminal stream for a subscribed session
//!
//! Attaches a tmux control-mode client (`tmux -C`) to the session and forwards
//! the pane's raw output bytes to the WebSocket client, so the browser's xterm
//! sees exactly what a real terminal would (full scrollback, colors, cursor).
//!
//! On start (and after the window is resized) a snapshot is sent: the pane's
//! history and screen from `capture-pane`, plus cursor position and modes.
//! tmux replies to commands in order with its output notifications, so every
//! `%output` after the snapshot's reply is exactly what follows it — no gaps
//! and no duplicates.

use std::process::Stdio;
use std::time::Duration;

use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{ChildStdin, Command};
use tokio::sync::mpsc;
use tracing::{debug, warn};

use super::messages::ServerMessage;

/// Max history lines included in a snapshot
const SNAPSHOT_HISTORY_LINES: usize = 10_000;

/// Wait for the app to redraw after a resize before re-snapshotting
const RESIZE_SNAPSHOT_DELAY: Duration = Duration::from_millis(500);

/// Format for the pane state queried alongside each snapshot
const PANE_STATE_FORMAT: &str = "#{pane_id} #{cursor_x} #{cursor_y} #{pane_height} #{alternate_on} \
#{cursor_flag} #{keypad_cursor_flag} #{scroll_region_upper} #{scroll_region_lower} \
#{mouse_standard_flag} #{mouse_button_flag} #{mouse_all_flag} #{mouse_sgr_flag}";

/// Stream a session's terminal to `tx` until the session ends or the receiver
/// is dropped. Intended to be spawned as a task and aborted on unsubscribe.
pub async fn run(session_id: String, tx: mpsc::Sender<ServerMessage>) {
    let mut child = match Command::new("tmux")
        .args(["-C", "attach-session", "-f", "ignore-size,read-only", "-t", &session_id])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
    {
        Ok(c) => c,
        Err(e) => {
            warn!(session = %session_id, error = %e, "Failed to start tmux control client");
            return;
        }
    };

    let (Some(mut stdin), Some(stdout)) = (child.stdin.take(), child.stdout.take()) else {
        return;
    };
    let mut reader = BufReader::new(stdout);

    if request_snapshot(&mut stdin, &session_id).await.is_err() {
        return;
    }

    let mut parser = ControlParser::default();
    let mut pane_id: Option<String> = None;
    let mut out = Utf8Buffer::default();
    let mut line = Vec::new();
    let mut resnapshot_at: Option<tokio::time::Instant> = None;

    loop {
        // read_until is cancel-safe: if the timer wins, partial bytes stay in `line`
        let read = match resnapshot_at {
            Some(at) => tokio::select! {
                r = reader.read_until(b'\n', &mut line) => r,
                _ = tokio::time::sleep_until(at) => {
                    resnapshot_at = None;
                    if request_snapshot(&mut stdin, &session_id).await.is_err() {
                        break;
                    }
                    continue;
                }
            },
            None => reader.read_until(b'\n', &mut line).await,
        };
        match read {
            Ok(0) | Err(_) => break,
            Ok(_) => {}
        }
        let mut current = std::mem::take(&mut line);
        if current.last() == Some(&b'\n') {
            current.pop();
        }

        match parser.feed(&current) {
            ControlEvent::None => {}
            ControlEvent::Exit => break,
            ControlEvent::Output { pane, data } => {
                // Ignore output until the first snapshot, which already contains it
                if pane_id.as_deref() == Some(pane) {
                    out.push(&data);
                }
            }
            ControlEvent::LayoutChange => {
                resnapshot_at = Some(tokio::time::Instant::now() + RESIZE_SNAPSHOT_DELAY);
            }
            ControlEvent::Reply(lines) => {
                if let Some(capture) = parser.pending_capture.take() {
                    let Some(state) = lines.first().and_then(|l| PaneState::parse(l)) else {
                        warn!(session = %session_id, "Unexpected pane state reply");
                        continue;
                    };
                    // Output that arrived before this reply is already in the snapshot
                    out.clear();
                    pane_id = Some(state.pane_id.clone());
                    let data = build_snapshot(&capture, &state);
                    if tx.send(terminal_msg(&session_id, data, true)).await.is_err() {
                        break;
                    }
                } else {
                    parser.pending_capture = Some(lines);
                }
            }
        }

        // Coalesce: flush once tmux has nothing more buffered for us
        if reader.buffer().is_empty() {
            let data = out.take();
            if !data.is_empty() && tx.send(terminal_msg(&session_id, data, false)).await.is_err() {
                break;
            }
        }
    }

    debug!(session = %session_id, "Terminal stream ended");
}

fn terminal_msg(session_id: &str, data: String, reset: bool) -> ServerMessage {
    ServerMessage::Terminal {
        session_id: session_id.to_string(),
        data,
        reset,
    }
}

/// Ask tmux for the pane's contents and state. The two replies arrive back to back.
async fn request_snapshot(stdin: &mut ChildStdin, session_id: &str) -> std::io::Result<()> {
    let cmd = format!(
        "capture-pane -p -e -S -{} -t {} ; display-message -p -t {} '{}'\n",
        SNAPSHOT_HISTORY_LINES, session_id, session_id, PANE_STATE_FORMAT
    );
    stdin.write_all(cmd.as_bytes()).await?;
    stdin.flush().await
}

// =============================================================================
// Control-mode protocol parsing
// =============================================================================

#[derive(Debug, PartialEq)]
enum ControlEvent<'a> {
    None,
    /// `%output` for a pane, with escapes decoded
    Output { pane: &'a str, data: Vec<u8> },
    /// A complete reply to one of our commands
    Reply(Vec<Vec<u8>>),
    /// The window layout (size) changed
    LayoutChange,
    /// The control client is exiting
    Exit,
}

#[derive(Default)]
struct ControlParser {
    /// Lines of the reply currently being read, if inside a `%begin` block
    block: Option<Vec<Vec<u8>>>,
    /// Whether the current block answers a command we sent (flags = 1)
    block_is_ours: bool,
    /// The capture-pane reply, waiting for its matching pane-state reply
    pending_capture: Option<Vec<Vec<u8>>>,
}

impl ControlParser {
    fn feed<'a>(&mut self, line: &'a [u8]) -> ControlEvent<'a> {
        if let Some(block) = self.block.as_mut() {
            // Notifications never appear inside a block, so only %end/%error close it
            if line.starts_with(b"%end ") || line.starts_with(b"%error ") {
                let lines = self.block.take().unwrap_or_default();
                if self.block_is_ours {
                    return ControlEvent::Reply(lines);
                }
                return ControlEvent::None;
            }
            block.push(line.to_vec());
            return ControlEvent::None;
        }

        if let Some(rest) = line.strip_prefix(b"%begin ") {
            // %begin <time> <command number> <flags>; flags 1 = sent by this client
            self.block_is_ours = rest.split(|&b| b == b' ').nth(2) == Some(b"1");
            self.block = Some(Vec::new());
            return ControlEvent::None;
        }
        if let Some(rest) = line.strip_prefix(b"%output ") {
            let Some(space) = rest.iter().position(|&b| b == b' ') else {
                return ControlEvent::None;
            };
            let Ok(pane) = std::str::from_utf8(&rest[..space]) else {
                return ControlEvent::None;
            };
            return ControlEvent::Output {
                pane,
                data: decode_output(&rest[space + 1..]),
            };
        }
        if line.starts_with(b"%layout-change ") {
            return ControlEvent::LayoutChange;
        }
        if line == b"%exit" || line.starts_with(b"%exit ") {
            return ControlEvent::Exit;
        }
        ControlEvent::None
    }
}

/// Decode `%output` data: tmux escapes control characters and `\` as `\ooo` octal
fn decode_output(data: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(data.len());
    let mut i = 0;
    while i < data.len() {
        if data[i] == b'\\' && i + 3 < data.len() && data[i + 1..i + 4].iter().all(|b| (b'0'..=b'7').contains(b)) {
            let v = (data[i + 1] - b'0') as u32 * 64 + (data[i + 2] - b'0') as u32 * 8 + (data[i + 3] - b'0') as u32;
            out.push(v as u8);
            i += 4;
        } else {
            out.push(data[i]);
            i += 1;
        }
    }
    out
}

// =============================================================================
// Snapshot
// =============================================================================

#[derive(Debug, PartialEq)]
struct PaneState {
    pane_id: String,
    cursor_x: u32,
    cursor_y: u32,
    height: u32,
    alternate_on: bool,
    cursor_visible: bool,
    keypad_cursor: bool,
    scroll_upper: u32,
    scroll_lower: u32,
    /// Mouse reporting modes (1000 / 1002 / 1003) and SGR encoding (1006)
    mouse_standard: bool,
    mouse_button: bool,
    mouse_all: bool,
    mouse_sgr: bool,
}

impl PaneState {
    fn parse(line: &[u8]) -> Option<Self> {
        let s = std::str::from_utf8(line).ok()?;
        let f: Vec<&str> = s.split_whitespace().collect();
        if f.len() != 13 || !f[0].starts_with('%') {
            return None;
        }
        let n = |i: usize| f[i].parse::<u32>().ok();
        Some(Self {
            pane_id: f[0].to_string(),
            cursor_x: n(1)?,
            cursor_y: n(2)?,
            height: n(3)?,
            alternate_on: f[4] == "1",
            cursor_visible: f[5] == "1",
            keypad_cursor: f[6] == "1",
            scroll_upper: n(7)?,
            scroll_lower: n(8)?,
            mouse_standard: f[9] == "1",
            mouse_button: f[10] == "1",
            mouse_all: f[11] == "1",
            mouse_sgr: f[12] == "1",
        })
    }
}

/// Build terminal bytes that reproduce the pane: history and screen lines, then
/// the cursor position and modes. The last `height` lines are the visible screen,
/// so with a matching terminal size they land exactly where tmux has them.
fn build_snapshot(capture: &[Vec<u8>], state: &PaneState) -> String {
    let mut s = String::new();
    if state.alternate_on {
        s.push_str("\x1b[?1049h\x1b[H");
    }
    let lines: Vec<String> = capture.iter().map(|l| String::from_utf8_lossy(l).into_owned()).collect();
    s.push_str(&lines.join("\r\n"));
    s.push_str("\x1b[0m");
    if state.scroll_upper != 0 || state.scroll_lower + 1 != state.height {
        s.push_str(&format!("\x1b[{};{}r", state.scroll_upper + 1, state.scroll_lower + 1));
    }
    s.push_str(&format!("\x1b[{};{}H", state.cursor_y + 1, state.cursor_x + 1));
    if state.keypad_cursor {
        s.push_str("\x1b[?1h");
    }
    // Restore mouse reporting so the client forwards wheel/clicks to apps that asked
    // for them (e.g. Claude Code's fullscreen renderer scrolls on mouse wheel)
    for (on, mode) in [
        (state.mouse_standard, 1000),
        (state.mouse_button, 1002),
        (state.mouse_all, 1003),
        (state.mouse_sgr, 1006),
    ] {
        if on {
            s.push_str(&format!("\x1b[?{}h", mode));
        }
    }
    if !state.cursor_visible {
        s.push_str("\x1b[?25l");
    }
    s
}

// =============================================================================
// UTF-8 reassembly
// =============================================================================

/// Accumulates output bytes and hands back valid UTF-8, holding back a
/// multi-byte character split across `%output` notifications.
#[derive(Default)]
struct Utf8Buffer {
    bytes: Vec<u8>,
}

impl Utf8Buffer {
    fn push(&mut self, data: &[u8]) {
        self.bytes.extend_from_slice(data);
    }

    fn clear(&mut self) {
        self.bytes.clear();
    }

    /// Take all complete characters; an incomplete trailing sequence stays buffered.
    fn take(&mut self) -> String {
        let mut out = String::new();
        loop {
            match std::str::from_utf8(&self.bytes) {
                Ok(s) => {
                    out.push_str(s);
                    self.bytes.clear();
                    return out;
                }
                Err(e) => {
                    let valid = e.valid_up_to();
                    out.push_str(std::str::from_utf8(&self.bytes[..valid]).unwrap_or_default());
                    match e.error_len() {
                        Some(bad) => {
                            out.push('\u{FFFD}');
                            self.bytes.drain(..valid + bad);
                        }
                        None => {
                            self.bytes.drain(..valid);
                            return out;
                        }
                    }
                }
            }
        }
    }
}

// =============================================================================
// Unit Tests
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    /// End to end against a real tmux server: `cargo test -- --ignored terminal_stream`
    #[tokio::test]
    #[ignore]
    async fn test_stream_real_tmux() {
        let name = format!("wc-stream-test-{}", std::process::id());
        let tmux = |args: &[&str]| std::process::Command::new("tmux").args(args).output().unwrap();
        tmux(&["new-session", "-d", "-s", &name, "-x", "80", "-y", "10",
               "for i in $(seq 1 30); do echo hist-$i; done; cat"]);
        tokio::time::sleep(Duration::from_millis(300)).await;

        let (tx, mut rx) = mpsc::channel(64);
        let task = tokio::spawn(run(name.clone(), tx));
        async fn recv(rx: &mut mpsc::Receiver<ServerMessage>) -> (String, bool) {
            match tokio::time::timeout(Duration::from_secs(3), rx.recv()).await {
                Ok(Some(ServerMessage::Terminal { data, reset, .. })) => (data, reset),
                other => panic!("no terminal message (timed out: {})", other.is_err()),
            }
        }

        // Snapshot holds all history, not just the screen
        let (snap, reset) = recv(&mut rx).await;
        assert!(reset);
        assert!(snap.contains("hist-1\r\n") && snap.contains("hist-30"), "{snap:?}");

        // Live output streams after the snapshot, raw (é split-safe, escapes intact)
        tmux(&["send-keys", "-t", &name, "-l", "héllo"]);
        let mut live = String::new();
        while !live.contains("héllo") {
            let (data, reset) = recv(&mut rx).await;
            assert!(!reset);
            live.push_str(&data);
        }

        // A resize triggers a fresh snapshot
        tmux(&["resize-window", "-t", &name, "-x", "60", "-y", "12"]);
        loop {
            let (data, reset) = recv(&mut rx).await;
            if reset {
                assert!(data.contains("hist-1\r\n"));
                break;
            }
        }

        // Ignore-size: the control client did not change the window size
        let size = tmux(&["display", "-p", "-t", &name, "#{window_width}x#{window_height}"]);
        assert_eq!(String::from_utf8_lossy(&size.stdout).trim(), "60x12");

        tmux(&["kill-session", "-t", &name]);
        tokio::time::timeout(Duration::from_secs(3), task).await.expect("stream ends with session").unwrap();
    }

    #[test]
    fn test_decode_output_octal_escapes() {
        assert_eq!(decode_output(br"a\033[31mb\015\012"), b"a\x1b[31mb\r\n");
        assert_eq!(decode_output(br"back\134slash"), b"back\\slash");
        assert_eq!(decode_output("é".as_bytes()), "é".as_bytes());
    }

    #[test]
    fn test_decode_output_trailing_backslash() {
        assert_eq!(decode_output(br"ab\0"), b"ab\\0");
    }

    #[test]
    fn test_parser_output() {
        let mut p = ControlParser::default();
        assert_eq!(
            p.feed(br"%output %4 hi\015\012"),
            ControlEvent::Output { pane: "%4", data: b"hi\r\n".to_vec() }
        );
    }

    #[test]
    fn test_parser_only_our_replies() {
        let mut p = ControlParser::default();
        // The attach command's own reply (flags 0) is ignored
        assert_eq!(p.feed(b"%begin 1 100 0"), ControlEvent::None);
        assert_eq!(p.feed(b"%end 1 100 0"), ControlEvent::None);

        assert_eq!(p.feed(b"%begin 1 101 1"), ControlEvent::None);
        // Lines inside a block are content, even if they look like notifications
        assert_eq!(p.feed(b"%output %1 not output"), ControlEvent::None);
        assert_eq!(p.feed(b"line two"), ControlEvent::None);
        assert_eq!(
            p.feed(b"%end 1 101 1"),
            ControlEvent::Reply(vec![b"%output %1 not output".to_vec(), b"line two".to_vec()])
        );
    }

    #[test]
    fn test_parser_error_reply_and_exit() {
        let mut p = ControlParser::default();
        p.feed(b"%begin 1 5 1");
        p.feed(b"can't find session");
        assert_eq!(p.feed(b"%error 1 5 1"), ControlEvent::Reply(vec![b"can't find session".to_vec()]));
        assert_eq!(p.feed(b"%layout-change @1 abc,80x24,0,0,1 abc,80x24,0,0,1 *"), ControlEvent::LayoutChange);
        assert_eq!(p.feed(b"%exit"), ControlEvent::Exit);
    }

    #[test]
    fn test_pane_state_parse() {
        let s = PaneState::parse(b"%3 4 10 24 0 1 0 0 23 0 0 0 0").unwrap();
        assert_eq!(s.pane_id, "%3");
        assert_eq!((s.cursor_x, s.cursor_y, s.height), (4, 10, 24));
        assert!(s.cursor_visible && !s.alternate_on && !s.keypad_cursor);
        assert!(PaneState::parse(b"can't find session").is_none());
    }

    #[test]
    fn test_build_snapshot() {
        let state = PaneState::parse(b"%3 2 1 2 0 0 1 0 1 0 0 0 0").unwrap();
        let capture = vec![b"history".to_vec(), b"\x1b[31mscreen1".to_vec(), b"$ ".to_vec()];
        assert_eq!(
            build_snapshot(&capture, &state),
            "history\r\n\x1b[31mscreen1\r\n$ \x1b[0m\x1b[2;3H\x1b[?1h\x1b[?25l"
        );
    }

    #[test]
    fn test_build_snapshot_scroll_region_and_alternate() {
        let state = PaneState::parse(b"%3 0 0 10 1 1 0 2 8 0 0 1 1").unwrap();
        assert_eq!(
            build_snapshot(&[b"vim".to_vec()], &state),
            "\x1b[?1049h\x1b[Hvim\x1b[0m\x1b[3;9r\x1b[1;1H\x1b[?1003h\x1b[?1006h"
        );
    }

    #[test]
    fn test_utf8_buffer_split_character() {
        let mut b = Utf8Buffer::default();
        let e = "é".as_bytes();
        b.push(b"caf");
        b.push(&e[..1]);
        assert_eq!(b.take(), "caf");
        b.push(&e[1..]);
        assert_eq!(b.take(), "é");
    }

    #[test]
    fn test_utf8_buffer_invalid_bytes() {
        let mut b = Utf8Buffer::default();
        b.push(b"a\xffb");
        assert_eq!(b.take(), "a\u{FFFD}b");
    }
}
