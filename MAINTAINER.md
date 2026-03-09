# Woodchuck Self-Healing Maintainer — Design Document

## Concept

A dedicated hidden Claude Code session ("the maintainer") that runs as a Ralph Loop against the woodchuck repo. Other sessions can report bugs, suggestions, and errors. The maintainer picks them up, investigates, writes fixes + tests, runs the test suite (cargo test + Playwright e2e), and if everything passes — rebuilds and restarts woodchuck.

---

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│  Any Session (Claude Code working on user project)       │
│                                                          │
│  Detects woodchuck issue → writes to inbox               │
│    Option A: Claude writes file to ~/.woodchuck/inbox/   │
│    Option B: curl POST /api/maintainer/inbox             │
└──────────────┬───────────────────────────────────────────┘
               │
               ▼
┌──────────────────────────────────────────────────────────┐
│  Inbox System  (~/.woodchuck/inbox/*.md)                 │
│                                                          │
│  Backend watches directory (poller)                      │
│  When new files appear → feeds to maintainer session     │
└──────────────┬───────────────────────────────────────────┘
               │
               ▼
┌──────────────────────────────────────────────────────────┐
│  Maintainer Session (Ralph Loop)                         │
│                                                          │
│  tmux session: "woodchuck-maintainer"                    │
│  cwd: /Users/baruchi-admin/projects/woodchuck            │
│  cmd: claude --dangerously-skip-permissions              │
│                                                          │
│  CLAUDE.md instructions:                                 │
│  - You are the woodchuck maintainer                      │
│  - Read inbox messages from stdin                        │
│  - Investigate, fix, add tests                           │
│  - Run: cargo test                                       │
│  - Run: npx playwright test (if frontend changes)        │
│  - Run: cargo build --release                            │
│  - Signal ready by writing ~/.woodchuck/deploy-ready     │
│                                                          │
│  Ralph Loop behavior:                                    │
│  - When status=needs_input → auto-send "y" or Enter      │
│  - When status=resting → check inbox for more work       │
│  - Max iterations per issue: 5 (prevent loops)           │
│  - Cooldown between issues: 60s                          │
└──────────────┬───────────────────────────────────────────┘
               │
               ▼
┌──────────────────────────────────────────────────────────┐
│  Deploy Pipeline                                         │
│                                                          │
│  Backend detects deploy-ready file:                      │
│  1. Verify cargo test passes (double-check)              │
│  2. Verify cargo build --release succeeded               │
│  3. Copy binary to deploy location                       │
│  4. Send push notification: "Deploying in 60s..."        │
│  5. Wait 60s (abort window)                              │
│  6. Graceful shutdown + re-exec                          │
│                                                          │
│  Safety:                                                 │
│  - Keep previous binary as rollback                      │
│  - Max 1 deploy per hour                                 │
│  - If new binary crashes within 30s → auto-rollback      │
│  - Push notification on success/failure                  │
└──────────────────────────────────────────────────────────┘
```

---

## Component Breakdown

### 1. Ralph Loop Engine (generic, reusable)

The ralph loop is a behavior layer on top of any session. It auto-responds to prompts when the session needs input.

**Backend changes:**

**New file: `src/controller/ralph.rs`**
- `RalphConfig` struct:
  ```rust
  pub struct RalphConfig {
      pub session_id: String,
      pub auto_responses: Vec<AutoResponse>,  // pattern → response mappings
      pub max_iterations: u32,                // safety limit
      pub cooldown_ms: u64,                   // between auto-responses
      pub on_resting: RalphOnResting,         // what to do when agent finishes
  }

  pub enum RalphOnResting {
      Stop,                  // do nothing, wait
      CheckInbox(String),    // check a directory for new tasks
      Repeat(String),        // send the same prompt again
  }

  pub struct AutoResponse {
      pub pattern: regex::Regex,  // match against last lines of output
      pub response: String,       // what to send
  }
  ```

- `start_ralph_loop()` function:
  - Runs as a background task (like the poller)
  - Watches session status via `SharedSessionStates`
  - When `NeedsInput` → checks patterns → sends auto-response
  - When `Resting` → executes `on_resting` behavior
  - Tracks iteration count, enforces limits
  - Stops if session is killed

**Integration with poller:**
- The ralph loop piggybacks on the existing poller's status detection
- No duplicate tmux polling — it reads from `SharedSessionStates`
- When it needs to send input, it uses `tmux.send_keys()`

### 2. Maintainer Session (specific ralph loop instance)

**Session properties:**
- ID: `woodchuck-maintainer`
- Name: "Woodchuck Maintainer"
- Folder: woodchuck repo directory (from config or auto-detected)
- Command: `claude --dangerously-skip-permissions` (needs full access to fix things)
- Hidden: not shown in `GET /api/sessions` by default
- Persisted: survives server restart (re-attached if tmux session still exists)

**Auto-created on startup:**
- In `controller::start()`, after initializing session states
- Only if no `woodchuck-maintainer` tmux session exists
- If it already exists (from before restart), just re-attach tracking

**Ralph config for maintainer:**
```rust
RalphConfig {
    session_id: "woodchuck-maintainer",
    auto_responses: vec![
        // Claude Code permission prompts
        AutoResponse { pattern: r"(y/n)", response: "y" },
        AutoResponse { pattern: r"Trust this", response: "y" },
        AutoResponse { pattern: r"Do you want to", response: "y" },
        AutoResponse { pattern: r"Press Enter", response: "" },  // bare Enter
    ],
    max_iterations: 5,
    cooldown_ms: 2000,
    on_resting: RalphOnResting::CheckInbox("~/.woodchuck/inbox"),
}
```

### 3. Inbox System

**Directory:** `{data_dir}/inbox/` (default: `~/.woodchuck/inbox/`)

**File format:** Markdown files named `{timestamp}-{source}.md`
```markdown
# Bug Report
**From:** session-name (session-id)
**Time:** 2026-03-09T14:22:00Z
**Type:** bug

The terminal resize doesn't work on iPad Safari.
When opening a session in landscape, cols stays at 80.
```

**How sessions write to inbox:**

Option A — File-based (for Claude Code sessions on the same machine):
- Sessions include a CLAUDE.md instruction:
  "If you notice a bug or have an improvement for woodchuck, write a markdown file to ~/.woodchuck/inbox/"
- This is injected by the hook system when creating sessions

Option B — API endpoint:
```
POST /api/maintainer/inbox
{
  "source": "session-id",
  "type": "bug" | "suggestion" | "error",
  "message": "description..."
}
```
- Backend writes the file to the inbox directory
- Available to hooks, external scripts, or even the frontend

**Inbox processing (in ralph loop):**
- When maintainer is `Resting` and `on_resting = CheckInbox`:
  1. List files in inbox dir, sorted by timestamp
  2. Read oldest unprocessed file
  3. Move it to `inbox/processing/` (prevents re-read)
  4. Send content as input to maintainer session
  5. After maintainer finishes (back to Resting):
     - Move file to `inbox/done/` or `inbox/failed/`
  6. Check for next file

### 4. Deploy Pipeline

**Trigger:** Maintainer writes a `~/.woodchuck/deploy-ready` file after successful test+build.

**Or better:** The ralph loop detects that the maintainer is Resting after processing an inbox item, and checks:
1. Are there new git commits since last deploy? (`git log --oneline deploy-marker..HEAD`)
2. Did `cargo test` pass? (check exit code in output or run again)
3. Does a fresh `cargo build --release` binary exist?

**Deploy steps:**
```
1. cp target/release/woodchuck ~/.woodchuck/woodchuck-next
2. cp current-binary ~/.woodchuck/woodchuck-prev  (rollback)
3. Push notification: "Woodchuck self-upgrade ready. Deploying in 60s. Visit settings to abort."
4. 60-second countdown (abort via Settings page button or push notification action)
5. mv woodchuck-next → current binary location
6. exec() to replace process (or systemd restart)
```

**Rollback:**
- If new process doesn't respond to health check within 30s
- A watchdog script (or systemd) restarts with `-prev` binary
- Push notification: "Self-upgrade failed, rolled back"

**Rate limiting:**
- Max 1 deploy per hour
- Track last deploy time in `~/.woodchuck/last-deploy`

### 5. Frontend — Settings Page

**New section in SettingsPage: "Maintainer"**

Shows:
- Maintainer session status (Working/Resting/NeedsInput)
- Current task (from inbox filename or "Idle")
- Mini terminal view (embedded XtermTerminal, read-only)
- Inbox queue (pending items count + list)
- Deploy history (last 5 deploys with timestamp + result)
- Controls:
  - "Pause" button — stops ralph loop, maintainer stays alive but doesn't auto-respond
  - "Resume" button — restarts ralph loop
  - "Kill" button — kills maintainer session entirely
  - "Abort Deploy" button — visible during 60s countdown
  - "Submit Issue" — manual text input to add to inbox

**API endpoints needed:**
```
GET  /api/maintainer/status   → { status, current_task, queue_length, ralph_active, last_deploy }
POST /api/maintainer/inbox    → { success: true }
POST /api/maintainer/pause    → pause ralph loop
POST /api/maintainer/resume   → resume ralph loop
POST /api/maintainer/abort    → abort pending deploy
GET  /api/maintainer/output   → lightweight poll of maintainer terminal
```

### 6. Playwright E2E Tests

**Setup:** `playwright.config.ts` at project root

**Test scenarios:**
- `e2e/sessions.spec.ts` — create session, view output, send input, kill
- `e2e/maintainer.spec.ts` — verify maintainer visible in settings, submit issue, see it picked up
- `e2e/inbox.spec.ts` — POST to inbox API, verify file created, verify maintainer gets it

**Run by maintainer:** After making changes, maintainer runs:
```bash
cargo test && cd app && npx playwright test
```

### 7. Hook Injection for Session Self-Reporting

When woodchuck creates any session, inject an instruction into the session's CLAUDE.md (or a woodchuck-specific context file) that teaches Claude Code about the inbox:

```markdown
## Woodchuck Self-Healing

You are running inside a woodchuck-managed session. If you encounter any of the following:
- A bug in the woodchuck terminal (display glitches, input issues, resize problems)
- An error from the woodchuck API or WebSocket
- An idea to improve the woodchuck experience

Write a markdown file to ~/.woodchuck/inbox/ with the format:
- Filename: {timestamp}-{description}.md
- Content: describe the issue clearly with reproduction steps if applicable

The woodchuck maintainer will pick it up and fix it automatically.
```

---

## Implementation Order

### Phase 1: Ralph Loop Engine + Maintainer Basics
1. `src/controller/ralph.rs` — RalphConfig, start_ralph_loop
2. Maintainer session creation in `controller::start()`
3. Inbox directory creation on startup
4. `POST /api/maintainer/inbox` endpoint
5. Basic ralph loop: auto-respond to prompts, check inbox on resting

### Phase 2: Frontend + Observability
1. `GET /api/maintainer/status` endpoint
2. `GET /api/maintainer/output` endpoint (poll maintainer terminal)
3. Settings page: maintainer section with status + mini terminal
4. Settings page: inbox queue display
5. Settings page: manual issue submission

### Phase 3: Deploy Pipeline
1. Deploy readiness detection (new commits + tests pass)
2. Binary swap + rollback mechanism
3. Graceful restart (re-exec)
4. Push notification for deploy countdown
5. Abort mechanism
6. Rate limiting

### Phase 4: Playwright + Hook Injection
1. Playwright config + first smoke test
2. E2E tests for core session flow
3. E2E tests for maintainer flow
4. Hook injection to teach sessions about inbox
5. Maintainer runs Playwright as part of fix verification

### Phase 5: Hardening
1. Iteration limits + circuit breaker for failing fixes
2. Deploy rollback watchdog
3. Inbox dedup (don't process same issue twice)
4. Metrics/logging for maintainer activity
5. Tests for ralph loop, inbox processing, deploy pipeline

---

## Open Questions

1. **`--dangerously-skip-permissions` for maintainer?** — Needed for full autonomy, but risky. Alternative: configure Claude Code allowlist for the woodchuck repo only.

2. **Maintainer's CLAUDE.md** — Should it live at `/projects/woodchuck/.claude/maintainer.md` or be injected dynamically? If it's in the repo, the maintainer can improve its own instructions.

3. **Multiple maintainers?** — Start with one. Could later support specialized maintainers (frontend, backend, tests).

4. **What if the maintainer breaks woodchuck?** — The rollback binary ensures we can recover. But the maintainer could also corrupt the git repo. Consider: maintainer works on a branch, deploy merges to main. Or: maintainer works in a worktree.

5. **Resource limits** — The maintainer session runs 24/7. On a small server, this might be too much. Consider: maintainer only starts when there's inbox work, shuts down when idle for >30 min.
