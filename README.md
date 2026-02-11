# Woodchuck

A mobile-friendly PWA for managing Claude Code sessions from your phone. Run Claude Code on your desktop, monitor and interact with it from anywhere.

## What It Does

- **Monitor sessions** - See all your Claude Code sessions and their status (working, resting, needs input)
- **Send input** - Type responses to Claude from your phone
- **Push notifications** - Get notified when Claude needs your attention
- **Organize projects** - Group sessions into projects for better organization
- **Real-time updates** - WebSocket-based live terminal output

## Architecture

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│   Phone (PWA)   │────▶│  Rust Backend   │────▶│  tmux sessions  │
│   React/Vite    │◀────│  Axum server    │◀────│  Claude Code    │
└─────────────────┘     └─────────────────┘     └─────────────────┘
        ▲                       │
        │                       │
        └───────────────────────┘
           WebSocket + HTTP
```

## Prerequisites

- **Rust** (1.70+) - `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh`
- **Node.js** (18+) - for building the PWA
- **tmux** - `brew install tmux` (macOS) or `apt install tmux` (Linux)
- **Claude Code CLI** - must be installed and authenticated

## Quick Start (Local Only)

1. **Clone and install**
   ```bash
   git clone https://github.com/baruchih/woodchuck
   cd woodchuck/app && npm install
   ```

2. **Configure**
   ```bash
   cd ..
   cp .env.example .env
   # Edit .env - set PROJECTS_DIR to your projects folder
   ```

3. **Build and run**
   ```bash
   cd app && npm run prod
   ```

4. **Open** http://localhost:1212

## Mobile Access with Tailscale (Recommended)

To access Woodchuck from your phone, you need HTTPS. Tailscale makes this easy with automatic certificates.

### Step 1: Install Tailscale

**On your desktop (server):**
```bash
# macOS
brew install tailscale

# Linux
curl -fsSL https://tailscale.com/install.sh | sh
```

Start and authenticate:
```bash
tailscale up
```

**On your phone:**
- iOS: [App Store](https://apps.apple.com/app/tailscale/id1470499037)
- Android: [Play Store](https://play.google.com/store/apps/details?id=com.tailscale.ipn)

Sign in with the same account.

### Step 2: Enable HTTPS

1. **Enable HTTPS certificates in Tailscale admin console:**
   - Go to https://login.tailscale.com/admin/dns
   - Under "HTTPS Certificates", click "Enable HTTPS"

2. **Generate certificate for your machine:**
   ```bash
   # Find your machine name
   tailscale status
   # Example output: my-mac-studio.tail12345.ts.net

   # Generate cert (creates two files in current directory)
   tailscale cert my-mac-studio.tail12345.ts.net

   # Move to app/certs (this folder is gitignored)
   mkdir -p app/certs
   mv my-mac-studio.tail12345.ts.net.* app/certs/
   ```

3. **Configure environment:**
   ```bash
   # In .env
   TLS_CERT=app/certs/my-mac-studio.tail12345.ts.net.crt
   TLS_KEY=app/certs/my-mac-studio.tail12345.ts.net.key
   ```

4. **Update vite.config.ts** (for dev mode only):
   ```typescript
   // In app/vite.config.ts, update the https section:
   https: fs.existsSync(path.resolve(__dirname, 'certs/my-mac-studio.tail12345.ts.net.key'))
     ? {
         key: fs.readFileSync(path.resolve(__dirname, 'certs/my-mac-studio.tail12345.ts.net.key')),
         cert: fs.readFileSync(path.resolve(__dirname, 'certs/my-mac-studio.tail12345.ts.net.crt')),
       }
     : undefined,
   ```

5. **Restart Woodchuck** and access from your phone:
   ```
   https://my-mac-studio.tail12345.ts.net:1212
   ```

## Installing the PWA on Your Phone

### iOS (Safari)

1. Open https://your-machine.tailnet.ts.net:1212 in Safari
2. Tap the Share button (square with arrow)
3. Scroll down and tap "Add to Home Screen"
4. Tap "Add"

### Android (Chrome)

1. Open https://your-machine.tailnet.ts.net:1212 in Chrome
2. Tap the three-dot menu
3. Tap "Add to Home screen" or "Install app"
4. Tap "Add"

## Push Notifications (Optional)

Get notified when Claude needs your input or finishes a task.

### Setup VAPID Keys

```bash
# Generate VAPID keys
npx web-push generate-vapid-keys
```

Add to your `.env`:
```bash
VAPID_PRIVATE_KEY=<your-private-key>
VAPID_PUBLIC_KEY=<your-public-key>
```

### Enable in the App

1. Open the app on your phone
2. Tap the bell icon in the header
3. Allow notifications when prompted

**Note:** Push notifications require HTTPS, so you'll need Tailscale or another HTTPS setup.

## Configuration Reference

| Variable | Default | Description |
|----------|---------|-------------|
| `HTTP_PORT` | `1212` | HTTP/HTTPS server port |
| `LOG_LEVEL` | `info` | Logging level (trace, debug, info, warn, error) |
| `PROJECTS_DIR` | required | Directory containing your project folders |
| `STATIC_DIR` | `app/dist` | Built PWA files location |
| `SHUTDOWN_TIMEOUT_SECS` | `5` | Graceful shutdown timeout |
| `TLS_CERT` | - | Path to TLS certificate (enables HTTPS) |
| `TLS_KEY` | - | Path to TLS private key |
| `VAPID_PRIVATE_KEY` | - | Web Push private key |
| `VAPID_PUBLIC_KEY` | - | Web Push public key |
| `NTFY_SERVER` | - | ntfy.sh server URL (alternative notifications) |
| `NTFY_TOPIC` | - | ntfy.sh topic name |

## Development

### Backend (Rust)

```bash
# Check
cargo check

# Lint
cargo clippy

# Test
cargo test

# Run with hot reload
cargo watch -x run
```

### Frontend (React)

```bash
cd app

# Install dependencies
npm install

# Dev server (with hot reload)
npm run dev

# Lint
npm run lint

# Build for production
npm run build
```

## Troubleshooting

### "Service Worker registration failed"

This happens when accessing over HTTPS with a self-signed certificate. Solutions:
- Use `http://localhost:1212` for local development
- Use Tailscale for proper HTTPS certificates
- In Chrome, enable `chrome://flags/#allow-insecure-localhost`

### "No push subscriptions registered"

Push subscriptions are stored in memory and lost on server restart. Just re-enable notifications in the app after restarting.

### Sessions not detected

Make sure:
- tmux is installed and running
- Claude Code sessions are started in tmux
- Session names follow the pattern `{folder}_{random}` or you started them via Woodchuck

### Can't connect from phone

- Check both devices are on the same Tailscale network: `tailscale status`
- Verify the server is running: `curl https://your-machine.ts.net:1212/api/health`
- Check firewall isn't blocking port 1212

## License

MIT
