# Local Development TLS Setup

phone-terminal requires TLS everywhere — even in development. No `ws://` code path exists.
Use [mkcert](https://github.com/FiloSottile/mkcert) to generate locally-trusted certificates.

## Prerequisites

- macOS, Linux, or Windows with admin access
- Homebrew (macOS) or your platform's package manager

## Setup

### 1. Install mkcert

```bash
# macOS
brew install mkcert

# Linux (Debian/Ubuntu)
sudo apt install libnss3-tools
brew install mkcert   # or build from source

# Windows
choco install mkcert
```

### 2. Install the local CA

```bash
mkcert -install
```

This creates a local Certificate Authority trusted by your system and browsers.

### 3. Generate certificates

From the project root:

```bash
mkdir -p certs
mkcert -cert-file certs/localhost.pem -key-file certs/localhost-key.pem localhost 127.0.0.1
```

### 4. Configure environment

Add to your `.env` (or export in your shell):

```bash
TLS_CERT_PATH=certs/localhost.pem
TLS_KEY_PATH=certs/localhost-key.pem
```

The backend will refuse to start without valid TLS paths — this is intentional.

## Verification

```bash
# Backend should start on https://
npm run dev -w backend
# → "phone-terminal backend listening on https://localhost:3001"

# Phone app dev server (Vite) also uses HTTPS
npm run dev -w phone-app
# → "https://localhost:5173"
```

## Notes

- The `certs/` directory is in `.gitignore` — never commit certificates.
- `*.pem` and `*.key` files are also git-ignored as a safety net.
- In CI/production, use proper certificates (Let's Encrypt, ACM, etc.).
- There is no `ws://` fallback anywhere in the codebase. If TLS is misconfigured, the system fails closed rather than falling back to plaintext.

## Troubleshooting

| Problem | Solution |
|---------|----------|
| `Error: read ENOENT certs/localhost.pem` | Run the mkcert command in step 3 |
| Browser shows "not secure" | Run `mkcert -install` again |
| Node rejects self-signed cert | Set `NODE_TLS_REJECT_UNAUTHORIZED=0` for dev only |
| Phone can't connect to laptop | Use your LAN IP: `mkcert -cert-file certs/localhost.pem -key-file certs/localhost-key.pem localhost 127.0.0.1 192.168.x.x` |
