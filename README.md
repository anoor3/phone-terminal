# phone-terminal

Cryptographically secured phone-to-laptop remote terminal control.

Control your laptop's terminal from your phone — with every message signed, every session visible, and every command auditable.

## Security Model

- **Zero trust relay** — the backend cannot forge commands or impersonate your phone
- **ECDSA P-256 signatures** — every control message is cryptographically signed
- **Anti-replay** — monotonic sequence numbers + timestamp freshness window
- **Single-use pairing** — QR tokens expire in 120s, verification codes get 5 attempts max
- **Visible state** — the laptop ALWAYS shows connection status (green/red box)
- **Dangerous command confirmation** — happens on the laptop, not the phone
- **No ambient access** — no session outlives the CLI process

## Architecture

```
Phone (signs commands) ←→ Backend (dumb relay) ←→ CLI (verifies + executes)
```

See [docs/phone-terminal-guide.md](docs/phone-terminal-guide.md) for the full security specification.

## Project Structure

```
phone-terminal/
├── cli/          # npm package: phone-terminal (node-pty, QR, signature verification)
├── backend/      # Fastify relay server (Redis + Postgres)
├── phone-app/    # Vite + React phone web app (ECDSA keypair, xterm.js)
└── docs/         # Full product & security guide
```

## Status

🚧 Phase 1 (Secure Core) — in progress. See [PROGRESS.md](PROGRESS.md) for detailed task tracking.

## Development

Requires Node.js >= 20.0.0

```bash
npm install          # install all workspace dependencies
npm run build        # build all packages
```

## License

MIT
