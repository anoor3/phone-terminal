# phone-terminal

Cryptographically secured phone-to-laptop remote terminal control.

Control your laptop's terminal from your phone — with every message signed, every session visible, and every command auditable.

## Architecture

```
┌──────────────────┐        ┌──────────────────┐        ┌──────────────────┐
│   Phone (Web)    │◄──────►│  Backend (Relay)  │◄──────►│    CLI (Laptop)  │
│                  │  WSS   │                  │  WSS   │                  │
│ • ECDSA keypair  │        │ • Fastify + TLS  │        │ • node-pty       │
│ • Signs commands │        │ • Redis (pairing)│        │ • Verifies sigs  │
│ • xterm.js view  │        │ • Postgres (audit)│       │ • Executes cmds  │
└──────────────────┘        └──────────────────┘        └──────────────────┘
```

**The backend is a dumb relay.** It cannot forge commands or impersonate your phone. Every control message is ECDSA-signed by the phone's private key (which never leaves the device) and independently verified by the CLI.

## Security Guarantees

- **Zero-trust relay** — the backend cannot forge commands or impersonate your phone
- **ECDSA P-256 signatures** — every control message is cryptographically signed
- **Anti-replay** — monotonic sequence numbers + timestamp freshness window
- **Single-use pairing** — QR tokens expire in 120s, verification codes get 5 attempts max
- **Visible state** — the laptop ALWAYS shows connection status (green/red box)
- **Dangerous command confirmation** — happens on the laptop, not the phone
- **No ambient access** — no session outlives the CLI process
- **TLS everywhere** — no `ws://` code path exists, even in development
- **Idle timeout** — 15 min no input → auto-disconnect

## Prerequisites

- **Node.js** >= 20.0.0
- **PostgreSQL** >= 14
- **Redis** >= 6
- **mkcert** — for local TLS certificates

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Set up local TLS

See [docs/local-dev-tls.md](docs/local-dev-tls.md) for full instructions.

```bash
brew install mkcert
mkcert -install
mkdir -p certs
mkcert -cert-file certs/localhost.pem -key-file certs/localhost-key.pem localhost 127.0.0.1
```

### 3. Configure environment

Create a `.env` file in the project root (or export variables):

```bash
# TLS (required — server won't start without these)
TLS_CERT_PATH=certs/localhost.pem
TLS_KEY_PATH=certs/localhost-key.pem

# Backend
HOST=localhost
PORT=3001
REDIS_URL=redis://localhost:6379
DATABASE_URL=postgres://localhost:5432/phone_terminal

# Allowed origins for WebSocket connections (phone app URL)
ALLOWED_ORIGINS=https://localhost:5173
```

### 4. Run database migrations

```bash
npm run migrate -w backend
```

### 5. Start the backend

```bash
npm run dev -w backend
```

The backend will start on `https://localhost:3001`.

### 6. Start the phone app

```bash
npm run dev -w phone-app
```

The Vite dev server starts on `https://localhost:5173`.

### 7. Connect from CLI

```bash
npx phone-terminal connect
```

This displays a QR code. Scan it with your phone to pair.

## Development

```bash
npm install          # install all workspace dependencies
npm run build        # build all packages
```

### Project Structure

```
phone-terminal/
├── cli/                    # npm package: phone-terminal
│   └── src/
│       ├── index.ts        # CLI entry point
│       ├── connect.ts      # Pairing + WSS connection
│       ├── verify.ts       # ECDSA signature verification
│       ├── pty-io.ts       # PTY management (node-pty)
│       ├── dangerous-cmd.ts # Dangerous command detection
│       ├── status-box.ts   # Terminal status overlay
│       ├── session.ts      # Session state management
│       ├── code-submit.ts  # Verification code handling
│       ├── audit.ts        # Audit log formatting
│       └── teardown.ts     # Graceful shutdown
├── backend/                # Fastify relay server
│   ├── src/
│   │   ├── server.ts       # HTTPS/WSS server setup
│   │   ├── config.ts       # Environment validation
│   │   ├── http/           # REST endpoints (pair/init)
│   │   ├── ws/             # WebSocket handlers
│   │   │   ├── handler.ts  # Connection + origin validation
│   │   │   ├── router.ts   # Message type routing
│   │   │   ├── relay.ts    # Signed message relay
│   │   │   ├── disconnect.ts # Session teardown
│   │   │   └── idle-timeout.ts # 15-min idle auto-disconnect
│   │   ├── redis/          # Pairing state (TTL-based)
│   │   └── db/             # Postgres pool
│   ├── migrations/         # Database schema
│   └── tests/              # Integration test scaffolds
├── phone-app/              # Vite + React phone web app
│   └── src/
│       ├── App.tsx         # State machine (claim→code→connected→disconnected)
│       ├── ClaimPage.tsx   # QR scan → phone_claim
│       ├── CodePage.tsx    # Verification code entry
│       ├── ConnectedPage.tsx # Terminal + signed input
│       ├── DisconnectedPage.tsx
│       └── crypto.ts       # ECDSA P-256 keypair + signing
├── docs/                   # Documentation
│   ├── phone-terminal-guide.md  # Full security specification
│   ├── local-dev-tls.md         # mkcert setup guide
│   └── attack-simulation.md     # Adversarial testing checklist
└── scripts/
    └── check-no-plaintext-ws.sh # CI check: no ws:// in source
```

## Documentation

- **[Security Specification](docs/phone-terminal-guide.md)** — Complete security model, protocol, and design decisions
- **[Attack Simulation Checklist](docs/attack-simulation.md)** — 11 adversarial tests that must pass before deployment
- **[Local TLS Setup](docs/local-dev-tls.md)** — mkcert instructions for development

## Status

Phase 1 (Secure Core) — complete. See [PROGRESS.md](PROGRESS.md) for detailed task tracking.

## License

MIT
