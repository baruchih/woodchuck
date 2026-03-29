# Woodchuck

A mobile-first Progressive Web App for managing Claude Code sessions remotely. Monitor, control, and interact with headless Claude Code agents running in tmux from your phone or any browser.

## What It Does

Woodchuck lets you:

- **Monitor** Claude Code sessions running on a remote machine in real-time
- **Send prompts** and interact with Claude from your phone
- **Receive push notifications** when Claude needs input or finishes a task
- **Organize** sessions into projects with tags and templates
- **Browse files** in project directories with markdown preview, image viewer, and zip download
- **Self-heal** — an autonomous maintainer agent fixes bugs and deploys updates automatically

## Architecture

```
Phone/Browser ←→ WebSocket + HTTPS ←→ Woodchuck (Rust) ←→ tmux ←→ Claude Code
```

- **Backend:** Rust/Axum — HTTP + WebSocket server, session lifecycle, deploy pipeline
- **Frontend:** React/TypeScript PWA — xterm.js terminal, Tailwind CSS, service worker
- **Session layer:** tmux manages Claude Code processes (survives Woodchuck restarts)
- **Real-time:** WebSocket-first architecture — session list, status, and terminal output pushed to clients with no HTTP polling

## Key Features

### Session Management
- Create, rename, delete, and recover sessions
- Status tracking: Working, NeedsInput, Error, Resting (with debounce)
- Session recovery after power outage — respawns with `claude --continue`
- Orphaned session detection with recover/discard UI

### Terminal & Input
- Full xterm.js terminal with canvas rendering
- Multiline text input bar with slash command autocomplete
- Works on both desktop (keyboard) and mobile (touch + send button)
- Pinch-to-zoom, momentum scroll, long-press to select text

### Multi-Session View
- Up to 4 sessions side-by-side in a grid
- Per-pane input, file browser, and session info
- Keyboard shortcuts (Ctrl+1-4) to switch focus
- Includes the woodchuck maintainer session

### File Browser
- Browse project directories with lazy-loaded tree view
- Search files by name (recursive, debounced)
- Text file preview (50+ extensions) with font size controls
- Markdown preview with rendered formatting
- Image viewer with pinch-to-zoom and pan
- Download individual files or entire folders as ZIP
- Hidden files shown (.env, .zshrc, etc.)

### Push Notifications
- Web Push (standard) with VAPID keys
- ntfy.sh fallback for simpler setups
- Debounced: only fires after status is stable for 5+ seconds
- Deduplicated: one notification per status transition

### Self-Healing Maintainer
- Autonomous agent that watches an inbox directory for tasks
- Ralph loop: auto-responds to prompts, checks inbox when idle
- Tasks submitted via API or as markdown files in `~/.woodchuck/inbox/`
- After task completion, auto-detects code changes and triggers deploy
- Pause/resume from settings page

### Deploy Pipeline
- Binary self-upgrade with 60-second abort window
- Configurable deploy branch (default: `main`, changeable in settings)
- Deploy Local: build from current working tree without commit/push
- Auto-revert: 3 consecutive failures on non-main branch → reverts to main
- Deploy history log with success/fail/revert tracking
- Push notifications on deploy events
- Rollback to previous binary

### PWA
- Installable on iOS and Android home screens
- Landscape orientation support for wider terminal
- Service worker with precaching
- Auto-update detection with reload prompt
- Standalone mode (no browser chrome)

## Tech Stack

### Backend
- **Runtime:** Tokio (async)
- **Framework:** Axum 0.7 (HTTP + WebSocket on same port)
- **TLS:** Rustls (for Tailscale/HTTPS)
- **Serialization:** Serde + serde_json
- **Logging:** Tracing
- **Notifications:** web-push, reqwest (ntfy.sh)
- **Utilities:** chrono, regex, shell-escape, uuid, zip

### Frontend
- **UI:** React 18 + React Router 6
- **Terminal:** xterm.js 5 (canvas addon, fit addon, web-links)
- **Styling:** Tailwind CSS 3 + @tailwindcss/typography
- **Markdown:** marked
- **Build:** Vite 5 + vite-plugin-pwa
- **Testing:** Vitest + Playwright

## Configuration

Environment variables (`.env` file):

| Variable | Default | Description |
|----------|---------|-------------|
| `HTTP_PORT` | `1212` | Server port |
| `PROJECTS_DIR` | `~/projects` | Directory containing project folders |
| `DATA_DIR` | `~/.woodchuck` | Persistence directory |
| `LOG_LEVEL` | `info` | Log level |
| `TLS_CERT` | — | TLS certificate path (optional) |
| `TLS_KEY` | — | TLS private key path (optional) |
| `VAPID_PRIVATE_KEY` | — | Web Push private key (optional) |
| `VAPID_PUBLIC_KEY` | — | Web Push public key (optional) |
| `NTFY_SERVER` | — | ntfy.sh server URL (optional) |
| `NTFY_TOPIC` | — | ntfy.sh topic (optional) |
| `CORS_ORIGINS` | `*` | Allowed CORS origins |
| `EXTERNAL_URL` | `http://localhost:{port}` | URL for webhook callbacks |

## Running

### Development

```bash
# Backend (hot reload)
cargo watch -x run

# Frontend (HMR)
cd app && npm run dev
```

### Production

```bash
cd app && npm run prod
```

This builds the frontend, then runs the release binary serving everything on one port.

## Data Persistence

All state is stored in `~/.woodchuck/`:

- `sessions.json` — Session metadata (name, status, project, tags, folder)
- `deploy-settings.json` — Deploy branch configuration
- `deploy-history.json` — Deploy event log (capped at 20)
- `last-deploy-commit` — Last deployed commit hash
- `inbox/` — Maintainer task files (markdown)

Session state survives server restarts. tmux sessions survive everything (power outage recovery re-attaches with `claude --continue`).

## WebSocket Protocol

Single connection at `/ws` handles all real-time communication:

**Client → Server:** subscribe, unsubscribe, input, resize, get_sessions, create_session, delete_session, update_session

**Server → Client:** output, status, subscribed, sessions, session_created, session_deleted, session_updated, session_ended, ack, error

Request-response correlation via `request_id` field with 10-second timeout.

## Security Model

Designed for private networks (Tailscale, home LAN):

- No authentication (trusts the network)
- Session ID validation (alphanumeric + hyphens/underscores only)
- Shell escape on all user input sent to tmux
- Path traversal protection on file operations
- Rate limiting on write endpoints (30 burst, 5/sec)
- Optional TLS for encrypted transport

## API

~50 REST endpoints covering sessions, files, projects, templates, maintainer, deploy, and push notifications. The WebSocket handles high-frequency operations (session list, output streaming, input) while HTTP handles uploads, downloads, and infrequent operations.

See the source at `src/controller/http/handlers.rs` for the complete API.
