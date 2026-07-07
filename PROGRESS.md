# phone-terminal — Build Progress

## Project Overview

Cryptographically secured phone-to-laptop remote terminal control system. Every connection, command, and disconnection is loud, logged, and instantly killable. Nothing happens silently — ever.

## Security Commitments (Non-Negotiable)

- TLS/WSS ONLY — no plaintext WebSocket paths exist, even in development (mkcert for local)
- ECDSA P-256 keypair generated on phone, private key is non-extractable
- Every control message signed with sessionId + seq + ts (anti-replay)
- QR pairing token in URL fragment only (never hits server logs)
- 6-digit verification code: 5 attempts max, 120s TTL, single-use
- Backend is a dumb relay — cannot forge signatures, cannot execute commands
- CLI verifies signatures locally — does not trust backend for auth after pairing
- No session outlives its owning CLI process
- Dangerous commands confirmed on LAPTOP (not phone) before execution
- Hash-chained audit log for tamper evidence
- Exact pinned dependency versions — no ^ or ~ ranges
- No secrets, keys, certs, or .env files ever committed (enforced by .gitignore)

---

## Build Phases

### Phase 1 — Secure Core (current)

Everything required before anyone uses this for real work.

### Phase 2 — Hardening (future)

WebAuthn, full attack-simulation CI, CSP/SRI/Origin hardening.

### Phase 3 — Reach (future)

Multiple sessions, tmux, remembered devices.

### Phase 4 — Ecosystem (future)

VS Code extension, team/enterprise features.

---

## Task Progress

### Foundation

| # | Task | Status | Commit |
|---|------|--------|--------|
| 1 | Initialize monorepo structure (workspaces, tsconfig, .gitignore, docs/) | ✅ Done | — |

### Backend

| # | Task | Status | Commit |
|---|------|--------|--------|
| 2 | Scaffold Fastify + @fastify/websocket + TypeScript | ✅ Done | 45cf248 |
| 3 | Postgres schema (devices, sessions, audit_log) + migrations | ✅ Done | caa4d67 |
| 4 | Redis pairing store module (set/get/expire with TTL) | ✅ Done | 4bf3499 |
| 5 | POST /api/pair/init endpoint | ✅ Done | 735b081 |
| 6 | WebSocket handler with Origin check + rate limiting | ✅ Done | 87114f8 |
| 7 | WS cli_hello handler | ✅ Done | 56c3376 |
| 8 | WS phone_claim handler (single-use token) | ✅ Done | 6ab9c9c |
| 9 | Verification code generation + code_submit (5 attempts max) | ✅ Done | 0e0ce4a |
| 10 | Pairing completion (sessionId, deviceId, paired event) | ⬜ Pending | — |
| 11 | Control-phase relay (signed messages, defense-in-depth verify) | ⬜ Pending | — |
| 12 | Session disconnect handling (graceful + socket-close detection) | ⬜ Pending | — |
| 13 | Device revocation + force-drop active session | ⬜ Pending | — |

### CLI

| # | Task | Status | Commit |
|---|------|--------|--------|
| 14 | Scaffold npm package (node-pty, qrcode-terminal, chalk, boxen, ws) | ⬜ Pending | — |
| 15 | Connect command (call /pair/init, render QR, open WS) | ⬜ Pending | — |
| 16 | Code submission (read 6-digit from stdin, send to backend) | ⬜ Pending | — |
| 17 | Paired event → store pubkey, spawn pty, stdin interception | ⬜ Pending | — |
| 18 | Local signature verification (ECDSA P-256, seq, ts ±30s) | ⬜ Pending | — |
| 19 | Write verified input to pty, stream output back | ⬜ Pending | — |
| 20 | Status box UI (green/red, always visible) | ⬜ Pending | — |
| 21 | Dangerous command detection + laptop-side confirmation | ⬜ Pending | — |
| 22 | disconnect/devices/revoke/status commands | ⬜ Pending | — |
| 23 | Teardown handlers (SIGINT/SIGTERM/SIGHUP/exit) | ⬜ Pending | — |
| 24 | Audit log command + hash-chain verification | ⬜ Pending | — |

### Phone App

| # | Task | Status | Commit |
|---|------|--------|--------|
| 25 | Scaffold Vite + React + TypeScript + xterm.js | ⬜ Pending | — |
| 26 | Crypto module (ECDSA P-256 keypair, IndexedDB, sign) | ⬜ Pending | — |
| 27 | Claim page (read token from fragment, phone_claim) | ⬜ Pending | — |
| 28 | Code display page (6-digit, countdown timer) | ⬜ Pending | — |
| 29 | Connected page (xterm.js, signed input, disconnect) | ⬜ Pending | — |
| 30 | Disconnected page (red state, reason, no actions) | ⬜ Pending | — |

### Security & Quality

| # | Task | Status | Commit |
|---|------|--------|--------|
| 31 | TLS/WSS enforcement (mkcert, no ws:// paths) | ⬜ Pending | — |
| 32 | Idle timeout (15 min → auto-disconnect) | ⬜ Pending | — |
| 33 | Integration testing (e2e pairing, replay rejection) | ⬜ Pending | — |
| 34 | Attack simulation checklist (§11) | ⬜ Pending | — |
| 35 | Documentation (README, setup, architecture) | ⬜ Pending | — |

---

## Security Audit Notes

_Updated as we build. Any concern found is logged here with its resolution._

| Date | Concern | Resolution |
|------|---------|------------|
| 2026-07-06 | Initial setup | .gitignore blocks all secrets, keys, certs, env files. No sensitive data in repo. |

---

## Commit Log

| Date | Commit | Description |
|------|--------|-------------|
| 2026-07-06 | 3a39f18 | Task 1: Initialize monorepo structure |
| 2026-07-06 | 45cf248 | Task 2: Backend scaffold (Fastify + TLS + WS + rate limit) |
| 2026-07-06 | caa4d67 | Task 3: Postgres schema + migration setup |
| 2026-07-06 | 4bf3499 | Task 4: Redis pairing store (TTL, constant-time compare, single-use) |
