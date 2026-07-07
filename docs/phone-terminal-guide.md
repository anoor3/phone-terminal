# Phone → Terminal Remote Control
### Complete Product & Security Build Guide (v1.0)

> **Prime directive:** remote control is permitted **only** while the laptop terminal is visibly open, clearly marked as connected, and driven by a cryptographically paired phone. Every connection, command, and disconnection is loud, logged, and instantly killable. Nothing happens silently — ever.

---

## Table of Contents

0. [Threat Model](#0-threat-model)
1. [System Architecture](#1-system-architecture)
2. [Cryptographic Design](#2-cryptographic-design)
3. [Protocol Specification](#3-protocol-specification)
4. [Backend](#4-backend)
5. [CLI](#5-cli)
6. [Phone Web App](#6-phone-web-app)
7. [Dangerous Command Confirmation](#7-dangerous-command-confirmation)
8. [Audit Logging](#8-audit-logging)
9. [Session Lifecycle & Kill Switches](#9-session-lifecycle--kill-switches)
10. [Deployment & Infra Security](#10-deployment--infra-security)
11. [Attack Simulation Checklist](#11-attack-simulation-checklist)
12. [Build Phases](#12-build-phases)
13. [Repository Layout](#13-repository-layout)

---

## 0. Threat Model

### Assets being protected
- Shell access on the user's laptop (the terminal session)
- The private signing key on the phone (never leaves the device)
- Command history / audit trail
- The relay backend itself (must not become a standing shell proxy)

### Adversaries considered

| Adversary | Capability | Must be defeated by |
|---|---|---|
| Network eavesdropper | Can see traffic between phone/laptop/backend | TLS/WSS everywhere; signed payloads mean even a TLS failure doesn't grant control |
| Screenshot/shoulder-surfer | Sees the QR code or the 6-digit code on a screen | QR + code are single-use, short-lived (2 min), and useless without the private key generated **after** scanning |
| Malicious relay operator (partial trust) | Controls the backend | Backend never sees the private key, cannot forge signatures, can only *deny service*, not *impersonate* |
| Second phone / cloned link | Opens the same pairing URL | Only the *first* device to complete the pairing handshake gets bound; token is single-use and invalidated on first successful exchange |
| Stolen laptop / stolen phone | Gets physical access to one device | Compromise of the CLI's local secret only affects that one running session; compromise of the phone's IndexedDB key only matters while a pairing is active — device list + revoke lets the user nuke it remotely if seen later |
| Replay attacker | Records a valid signed message and resends it | `seq` (monotonic) + `ts` (freshness window) + `sessionId` binding in the signed payload |
| Malicious npm dependency / supply chain | Compromises the CLI or web bundle at install/build time | Lockfile pinning, `npm audit`/`socket.dev` in CI, SRI hashes on the phone page's JS bundle, minimal dependency surface |
| Idle/forgotten session | Phone stays paired after user walks away | Idle timeout auto-disconnects; visible status box never lets the user forget |

### Non-goals (explicitly out of scope for v1)
- Controlling terminals *not* launched by this tool (existing iTerm tabs, tmux panes, VS Code integrated terminals) — roadmap item, not a security shortcut. Trying to hook arbitrary existing shells first would mean a much bigger, harder-to-audit attack surface.
- Multi-phone-to-one-terminal fan-out (default is strictly 1:1 unless the user explicitly creates a second pairing).
- Persistent "always-on" shell access — there is no scenario where the phone can reach a shell after the laptop process exits.

---

## 1. System Architecture

```
 ┌────────────┐        WSS (signed msgs)        ┌────────────┐
 │  Phone Web │◄───────────────────────────────►│            │
 │    App     │                                  │            │
 │ (keypair,  │                                  │  Backend   │
 │  xterm.js) │                                  │   Relay    │
 └────────────┘                                  │ (stateless │
                                                  │  relay,    │
 ┌────────────┐        WSS (auth token)          │  verifies  │
 │  Local CLI │◄───────────────────────────────►│  sigs only)│
 │ (node-pty, │                                  │            │
 │  QR, TUI)  │                                  └─────┬──────┘
 └────────────┘                                        │
                                        ┌───────────────┴───────────────┐
                                        │                               │
                                   ┌────▼────┐                    ┌─────▼─────┐
                                   │  Redis  │                    │ Postgres  │
                                   │ (pairing│                    │ (devices, │
                                   │ sessions,│                   │  audit    │
                                   │  TTL)   │                    │   log)    │
                                   └─────────┘                    └───────────┘
```

**Critical design property:** the backend is a *dumb, verifying relay*. It never executes commands, never stores private keys, and cannot itself impersonate the phone because it cannot produce a valid signature. If the backend is fully compromised, the attacker gains the ability to **deny service** (drop/withhold messages) but **not** to inject commands into a terminal, because the CLI only accepts messages carrying a valid signature it can verify against the public key it recorded at pairing time — and critically, the CLI holds its own copy of that public key (see §2.5), so it does not have to trust the backend's word about which key is valid.

Two logically distinct sessions exist and must never be confused:

- **Pairing session** — short-lived (2 min), identified by `pairingId` + `pairingToken`, exists only to get from "QR scanned" to "public key recorded."
- **Control session** — long-lived (until disconnect), identified by `sessionId`, is what actually carries terminal I/O once pairing succeeds.

---

## 2. Cryptographic Design

### 2.1 Keypair
- Algorithm: **ECDSA P-256** via `crypto.subtle` (universally supported in mobile browsers, no extra libraries).
- Generated in the phone page, immediately after the pairing page loads — *not* before, so a pre-generated key can't be reused across pairings.
- Private key generated as `extractable: false` where the browser supports non-extractable ECDSA keys used with IndexedDB structured-clone storage (Chrome/Safari/Firefox all support storing a non-extractable `CryptoKey` in IndexedDB). This means even a browser-based JS injection attack after the fact cannot exfiltrate the raw private key material — it can only ask the key to sign things while the page is open.
- Public key exported as JWK, sent to the backend only after the human types the verification code (§2.3).

### 2.2 Pairing token (QR payload)
- 32 bytes from `crypto.randomBytes`, base64url-encoded → embedded in the QR as
  `https://pair.yourapp.com/p/<pairingId>#<pairingToken>`
- The token goes in the URL **fragment** (`#`), not the query string, so it is never sent to the backend's HTTP server in access logs, proxies, or Referer headers. The phone page reads it client-side and sends it only over the already-upgraded WSS connection.
- TTL: **120 seconds**, enforced by a Redis key (`EXPIRE`). After expiry the `pairingId` is deleted — a late scan gets an explicit "This code expired, run `connect` again" screen rather than a hang.
- Single-use: the moment the backend receives a valid `pairing_init` claim on a `pairingId`, that pairing session flips to `claimed` state; any second WS connection attempting to claim the same `pairingId` is rejected outright, closing that race before the verification-code step ever begins.

### 2.3 Verification code (human presence proof)
- 6-digit numeric, generated server-side, delivered to the phone over its live WebSocket connection (not embedded in the QR — this matters, see below).
- Why not put the code in the QR itself: the code's whole job is to prove the human at the phone and the human at the keyboard are the *same* person, in real time. If it travelled inside the QR, a photo of the QR would leak it too. Delivering it only after the phone has an open, freshly-authenticated socket keeps it tied to "a phone is live right now."
- Max 5 attempts, then the whole pairing session is invalidated and the CLI is told to show a fresh QR. Prevents brute force of a 6-digit space (1,000,000 possibilities) within the 2-minute window — 5 attempts is generous for a fat-fingered human, useless for a bot.
- The code is **never** treated as a bearer credential after this step. It's discarded the instant pairing completes.

### 2.4 Binding public key → control session
On code match:
1. Backend generates `sessionId` (32 random bytes) and `deviceId` (32 random bytes).
2. Stores `{ sessionId, deviceId, publicKeyJwk, deviceLabel, pairedAt }` in Postgres (`devices` + `sessions` tables, §4.2).
3. Sends the CLI a `paired` event containing `deviceId`, `deviceLabel` (e.g. browser/OS sniffed from User-Agent, or a name the user types on the phone), and the **public key itself** — the CLI stores its own local copy in memory for the duration of the process. This is the important bit: **the CLI does not trust the backend to re-tell it who's paired on every message** — it verifies signatures locally against the key it received once, at pairing time.
4. Pairing-session Redis keys are deleted immediately (token + code no longer exist anywhere).

### 2.5 Per-message authentication
Every phone → backend → CLI control message is a signed envelope:

```json
{
  "sessionId": "b64url...",
  "seq": 42,
  "ts": 1751800000000,
  "type": "input",
  "payload": "ls -la\n",
  "sig": "b64url(ECDSA-SHA256 signature over `sessionId|seq|ts|type|payload`)"
}
```

Verification (done by the **CLI**, redundantly to any check the backend does — defense in depth):
- `ts` within ±30s of local clock → otherwise reject as stale/replayed.
- `seq` strictly greater than last accepted `seq` for this `sessionId` → otherwise reject as a replay or out-of-order injection.
- Signature verifies against the public key recorded at pairing → otherwise reject and raise a loud terminal warning ("⚠ message failed verification, ignored").
- Any single verification failure does **not** kill the session by default (a dropped packet shouldn't disconnect you) but is written to the audit log; **3 consecutive failures** auto-disconnects the phone and shows a red alert, since that pattern is far more consistent with tampering than with normal jitter.

Output flows CLI → backend → phone unsigned (it's not a control channel — but see §10 for transport-level protections), though it is still scoped strictly to the one `sessionId`/socket.

---

## 3. Protocol Specification

### 3.1 REST
```
POST /api/pair/init
  → { pairingId, expiresAt }         # CLI calls this to start
```

### 3.2 WebSocket message types

| Direction | Type | Payload | Purpose |
|---|---|---|---|
| CLI → BE | `cli_hello` | `{ pairingId, cliSecret }` | CLI authenticates its own socket for this pairing |
| Phone → BE | `phone_claim` | `{ pairingId, pairingToken }` | Phone claims the pairing (must match, single-use) |
| BE → Phone | `code_challenge` | `{ code }` | Backend pushes the 6-digit code to phone only |
| Phone → BE → CLI | `code_submit` | *(user types into CLI, CLI sends)* `{ pairingId, code }` | Human types code back into terminal |
| BE → CLI, BE → Phone | `paired` | `{ sessionId, deviceId, publicKeyJwk, deviceLabel }` | Pairing complete, control session begins |
| Phone → BE → CLI | `input` | signed envelope, `type:"input"` | Keystrokes / commands |
| Phone → BE → CLI | `resize` | signed envelope, `type:"resize"`, `{cols,rows}` | Terminal resize from phone UI |
| CLI → BE → Phone | `output` | `{ sessionId, chunk }` | Terminal stdout/stderr stream |
| CLI → BE → Phone | `status` | `{ sessionId, state }` | e.g. "command running", "awaiting confirmation" |
| Phone → BE → CLI | `disconnect` | signed envelope | Phone-initiated graceful disconnect |
| CLI → BE → Phone | `disconnect` | `{ reason }` | Laptop-initiated (Ctrl+D, close, revoke) |
| both ↔ BE | `ping`/`pong` | — | Liveness; also drives idle-timeout |

### 3.3 Sequence: pairing
```
CLI                     Backend                    Phone
 │--POST /pair/init----->│                           │
 │<--pairingId, exp------│                           │
 │--WS cli_hello--------->│                           │
 │  (renders QR w/        │                           │
 │   pairingId+token)     │                           │
 │                        │<--WS connect + phone_claim│
 │                        │--code_challenge---------->│  (phone shows code)
 │                        │                           │
 │   [ human reads code off phone, types into CLI ]    │
 │--code_submit(code)---->│                           │
 │                        │--verify, gen session------│
 │<--paired(pubkey,id)----│--paired(sessionId)-------->│
 │  [PHONE CONNECTED]     │                           │  [connected UI]
```

### 3.4 Sequence: authenticated control message
```
Phone: build envelope → sign with private key → send `input`
Backend: check sessionId exists & not revoked → relay to CLI socket (does not need to verify sig itself, but does anyway as defense-in-depth against DoS-by-garbage)
CLI: verify sig locally against stored pubkey → check seq/ts → write to pty.write() → append audit row
```

---

## 4. Backend

### 4.1 Stack
- Node.js + `ws` (raw WebSocket) or Fastify with `@fastify/websocket`. Avoid frameworks that assume request/response only — this is long-lived duplex traffic.
- Redis for all pairing-phase ephemeral state (auto-expiring by design — perfect for a "must die in 120s" requirement).
- Postgres for anything that must outlive a single pairing: `devices`, `sessions`, `audit_log`.

### 4.2 Schemas

```sql
-- Postgres
create table devices (
  device_id      bytea primary key,
  owner_user_id  uuid not null,          -- if you add accounts later; else null
  public_key_jwk jsonb not null,
  label          text not null,
  created_at     timestamptz not null default now(),
  revoked_at     timestamptz
);

create table sessions (
  session_id     bytea primary key,
  device_id      bytea references devices(device_id),
  cli_instance   text not null,          -- opaque id for the running CLI process
  paired_at      timestamptz not null default now(),
  ended_at       timestamptz,
  end_reason     text                    -- 'ctrl_d' | 'terminal_closed' | 'revoked' | 'timeout' | 'phone_disconnect'
);

create table audit_log (
  id           bigserial primary key,
  session_id   bytea not null,
  ts           timestamptz not null default now(),
  event_type   text not null,            -- 'paired'|'input'|'disconnect'|'sig_fail'|'dangerous_confirm'
  detail       jsonb not null,
  prev_hash    text,                     -- hash-chain for tamper evidence, see §8
  row_hash     text not null
);
```

```text
# Redis keys (pairing phase only — everything here has a TTL)
pair:{pairingId}:token       -> pairingToken         EX 120
pair:{pairingId}:code        -> 6-digit code          EX 120
pair:{pairingId}:attempts    -> int counter           EX 120
pair:{pairingId}:state       -> "pending"|"claimed"   EX 120
```

### 4.3 Auth on each socket type
- **CLI socket:** authenticated with a `cliSecret` minted at `POST /api/pair/init` and never exposed to the phone. This secret is what lets the backend know "this socket is allowed to hear about pairing X."
- **Phone socket:** starts anonymous, becomes "claimed" only after presenting the correct `pairingToken`; after pairing completes, every subsequent message must carry a valid signature — the socket itself carries no ambient authority.

### 4.4 Rate limiting & abuse prevention
- `POST /api/pair/init`: per-IP limit (e.g. 20/min) — cheap to abuse otherwise (spinning up junk pairing sessions).
- `code_submit`: hard cap 5 attempts per `pairingId` (§2.3), independent of IP, because the attacker might rotate IPs.
- WS connection rate per IP via a token bucket in front of the upgrade handler.
- All of the above logged; sustained abuse from one IP triggers a temporary block (fail2ban-style, or a managed WAF if you're behind Cloudflare/Fastly).

### 4.5 Horizontal scaling note
If you run more than one backend instance, WS relay must fan out via Redis pub/sub (`PUBLISH session:{sessionId}`) so a phone connected to instance A and a CLI connected to instance B can still reach each other. Keep this in mind from day one even if you launch on a single instance — retrofitting pub/sub into a "just relay in-process" design later is a rewrite, not a patch.

---

## 5. CLI

### 5.1 Stack
- `node-pty` for the actual shell process.
- `qrcode-terminal` for the QR.
- `chalk` + `boxen` for the status box styling.
- Raw stdin handling — **not** a naive pipe.

### 5.2 Why stdin must be intercepted manually
`process.stdin.pipe(ptyProcess)` would forward every byte including Ctrl+D (0x04) and Ctrl+C (0x03) straight into the pty, which breaks two requirements at once: Ctrl+D needs to mean "disconnect phone," and Ctrl+C needs to keep meaning "send SIGINT to the running program" (e.g. stop `npm run dev`), not "disconnect."

```js
process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.on('data', (chunk) => {
  for (const byte of chunk) {
    if (byte === 0x04) {           // Ctrl+D
      disconnectPhone('ctrl_d');
      return;                      // swallow it — never forward to pty
    }
  }
  ptyProcess.write(chunk);          // Ctrl+C (0x03) and everything else passes through untouched
});
```

### 5.3 Status box (always-visible connection state)

```
┌──────────────────────────────────────────┐
│ ● PHONE CONNECTED                         │
│ Device : Abdullah's iPhone                │
│ Session: 8F2A-91CE                        │
│ Mode   : Remote Terminal Control          │
│                                            │
│ Ctrl+C  Stop running command              │
│ Ctrl+D  Disconnect phone                  │
└──────────────────────────────────────────┘
```
Rendered in green (`chalk.green`) on connect, and a matching red box on disconnect:

```
┌──────────────────────────────────────────┐
│ ○ PHONE DISCONNECTED                      │
│ Reason : manual (Ctrl+D)                  │
│ Session ended at 14:32:07                 │
└──────────────────────────────────────────┘
```
This box is re-rendered (not just printed once and scrolled away) any time terminal state changes — e.g. redraw it above the prompt after every command completes, so a user who looks away and back can never be in doubt about current state. There is intentionally no "quiet mode."

### 5.4 Commands
```
npx phone-terminal connect      # start a new pairing + session
npx phone-terminal disconnect   # kill the current phone session from this shell
npx phone-terminal devices      # list all devices ever paired to this machine, with last-seen + status
npx phone-terminal revoke <id>  # revoke a specific device permanently (Postgres update, works even if that device isn't currently connected)
npx phone-terminal status       # print current connection state and exit
```

### 5.5 Teardown guarantees
Register handlers for `SIGINT` (only relevant if no pty is running — otherwise it's forwarded), `SIGTERM`, `SIGHUP`, and `process.on('exit')`:
- Always send a best-effort `disconnect` message to the backend before exiting.
- Backend also independently expires any session whose CLI socket disconnects without a graceful message (detected via WS close event) — belt and suspenders, so a killed `-9` process can't leave a dangling "connected" state.
- No server-side timer keeps a pty alive after the CLI process exits — the pty's lifetime is a direct child of the CLI process lifetime, so there is no path to "phone still has a shell after laptop closed."

---

## 6. Phone Web App

### 6.1 Pages/states
1. **Scanning → Claiming** — brief loading state while `phone_claim` round-trips.
2. **Code display** — large, single 6-digit code, plus "Type this into your terminal" copy. Countdown ring showing the 120s expiry visually.
3. **Connected** — xterm.js view of the live terminal, an input bar, a persistent green "Connected to `<hostname>`" banner, and a prominent **Disconnect** button (phone-initiated graceful disconnect — the same courtesy as Ctrl+D on the laptop, symmetric control).
4. **Disconnected** — clear red state, explains why (`ended_reason`), offers nothing but "this session has ended — go back to your laptop to reconnect."

### 6.2 Key handling
- Keypair generated on page load (§2.1), never before.
- `IndexedDB` stores the non-extractable `CryptoKeyPair` scoped to that origin, cleared when the pairing page's session storage entry expires or on explicit "forget this device" in the phone UI itself.
- No `localStorage` used for anything security-relevant — `IndexedDB` handles the actual key material because it, unlike `localStorage`, supports storing non-extractable `CryptoKey` objects directly.

### 6.3 No service worker
Deliberately **not** using a service worker for this page. A service worker able to intercept fetches is extra attack surface for a page whose entire job is signing security-critical messages; the marginal offline-capability benefit isn't worth it here.

### 6.4 WebAuthn upgrade path (Phase 2)
For the "confirm this dangerous command" moment (§7), layering a WebAuthn (Face ID / fingerprint) prompt on top of the existing ECDSA session key gives you a *second*, biometric-backed factor specifically at the riskiest moments, without requiring WebAuthn for the base pairing flow (which would complicate cross-device/cross-browser support for v1).

---

## 7. Dangerous Command Confirmation

### 7.1 Where the confirmation happens
On the **laptop**, not the phone. The laptop is the ground truth for "what is about to run," so it's the laptop that must show the exact command and require a physical keypress there before execution — this also means a compromised or spoofed phone UI can't just self-approve.

### 7.2 Trigger patterns (configurable, ships with sane defaults)
Pattern-match on the input line before it reaches the pty:
- `rm -rf`, `rm -fr`, any `rm` with `-r` and `-f` combined
- `sudo`, `su -`
- `curl ... | sh`, `wget ... | bash` (pipe-to-shell)
- `git push --force`, `git push -f`
- `DROP TABLE`, `DELETE FROM ... ` without `WHERE` (best-effort SQL heuristics)
- `> /dev/sda`, disk-level device writes
- anything writing into `~/.ssh`, `~/.aws`, or other credential directories

### 7.3 Flow
```
Phone sends `input: "sudo rm -rf /var/log/old"` 
   → CLI detects dangerous pattern
   → CLI does NOT write to pty yet
   → CLI shows: "⚠ Phone wants to run: sudo rm -rf /var/log/old  — press Y to allow, N to block"
   → status: "awaiting confirmation" sent to phone (so the phone UI isn't left hanging with no feedback)
   → local keypress required
   → only then written to pty, and logged either way (approved/blocked) to audit_log
```

---

## 8. Audit Logging

- Every `paired`, `disconnect`, `input`, `sig_fail`, and `dangerous_confirm` event gets a row.
- **Hash chain** for tamper evidence: `row_hash = sha256(prev_hash + event_type + detail + ts)`. Doesn't prevent a fully-compromised DB from being rewritten wholesale, but makes silent, selective tampering with individual rows detectable — any broken link in the chain is a red flag on audit.
- CLI command: `phone-terminal audit --session <id>` prints a human-readable timeline; `--export json` dumps it for external log shipping (Splunk/Datadog/etc. in enterprise phase).
- Command payloads longer than a configurable limit are truncated in the log by default (avoid silently logging secrets typed as command args) with a `truncated: true` flag rather than logging everything unconditionally.

---

## 9. Session Lifecycle & Kill Switches

| Trigger | Effect |
|---|---|
| Ctrl+D on laptop | Immediate disconnect, red status, session marked `ended` |
| Phone taps "Disconnect" | Same as above, symmetric |
| Terminal window closed / CLI process exits (any reason) | pty dies as a direct child process; backend detects socket close and force-ends session |
| Idle timeout (default 15 min no input) | Auto-disconnect, distinct `end_reason: 'timeout'`, both sides notified |
| `phone-terminal revoke <deviceId>` | Permanently revokes that device's key — even a *currently connected* session for that device is force-dropped, and the device can never re-pair without a brand-new QR/keypair |
| 3 consecutive signature failures | Auto-disconnect + red alert, treated as a likely tamper event |
| Backend-initiated (abuse detected) | Backend can force-close a session; CLI treats backend-initiated disconnect same as any other — shows red status immediately, never silently |

**Guarantee:** there is no code path where a control session outlives its owning CLI process, and no code path where the phone retains any ability to send commands after any of the above triggers — revocation is enforced both by deleting the session record (so the backend stops relaying) and by the CLI dropping its in-memory public key for that session (so even a backend bug relaying a stale message gets rejected locally).

---

## 10. Deployment & Infra Security

- **TLS/WSS everywhere.** No plaintext WS, ever, including in dev (use mkcert locally rather than allowing an `ws://` code path to exist at all — the fewer code paths, the fewer chances to ship the wrong one).
- **HSTS** on the phone pairing page's domain.
- **Origin checks** on the WS upgrade handshake — reject connections whose `Origin` isn't your known pairing-page origin (defense against random sites trying to open sockets to your relay).
- **CSP** on the phone page: `default-src 'self'; connect-src wss://api.yourapp.com; script-src 'self'` — no inline scripts, no third-party script origins.
- **Subresource Integrity** on the phone page's JS bundle if served from any CDN.
- Secrets (DB creds, signing secrets for `cliSecret` minting) in a proper secrets manager, not `.env` committed anywhere.
- Dependency hygiene: lockfile committed, `npm audit` / Socket.dev in CI, minimal dependency tree (this is a security product — every added dependency is added attack surface, justify each one).
- Structured logging + alerting on: spikes in failed `code_submit` attempts, spikes in `sig_fail` audit events, unusual pairing-init volume per IP.

---

## 11. Attack Simulation Checklist

Run these before calling anything "done":

- [ ] Replay a captured QR URL after the original pairing completed → must fail (token invalidated on first claim).
- [ ] Screenshot the 6-digit code and submit it after 120s → must be expired.
- [ ] Brute-force the 6-digit code with 6+ attempts → must lock out at 5.
- [ ] Open the pairing URL in two different browsers simultaneously → only the first to complete claiming should succeed; the second gets a clear "already claimed" error.
- [ ] Capture a valid signed `input` envelope and resend it verbatim → must be rejected (`seq` reuse).
- [ ] Modify one byte of a valid signed envelope's `payload` and resend → signature must fail verification.
- [ ] Kill the CLI process with `-9` mid-session → backend must mark the session ended via socket-close detection, not linger.
- [ ] Revoke a device while its session is actively connected → must be dropped within one round-trip, not just refused on next pair attempt.
- [ ] Attempt to connect a WS client with no/incorrect `Origin` header → must be rejected at the handshake.
- [ ] Attempt pairing over `ws://` instead of `wss://` → must be impossible (no such listener exists).
- [ ] Fuzz the dangerous-command matcher with obfuscated variants (`s\u200Budo`, `r""m -rf`) → decide explicitly whether this is in scope for v1 (recommend: document as a known limitation of pattern-matching-based confirmation, not a promise of unbypassable detection — the real backstop is that the *laptop* is always visibly showing what's running).

---

## 12. Build Phases

### Phase 1 — Secure Core (the only phase that must ship before anyone uses this for real work)
CLI `connect`, QR pairing, code confirmation, ECDSA keypair + signed messages, node-pty single session, status box (green/red), Ctrl+D/Ctrl+C correct behavior, `disconnect`/`devices`/`revoke` commands, basic audit log, all of §2's crypto, TLS/WSS only.

### Phase 2 — Hardening
WebAuthn-backed confirmation for dangerous commands, hash-chained audit log, idle timeout, rate limiting + abuse monitoring, CSP/SRI/Origin checks locked down, full attack-simulation checklist passing in CI (automated where possible).

### Phase 3 — Reach
Multiple concurrent terminal sessions per user (still 1 phone : 1 terminal each, never fan-out), tmux pane support, "remembered devices" UX so re-pairing a known phone can optionally skip straight to a lighter-weight re-auth (still no ambient trust — re-auth still requires a fresh proof, just possibly faster UX), device nicknames/icons.

### Phase 4 — Ecosystem
VS Code extension (own pairing surface, reuses the same backend/protocol), iTerm2 integration, team/enterprise features: org-level device policари, SSO, centralized audit export, per-org dangerous-command policy configuration.

---

## 13. Repository Layout

```
phone-terminal/
├── cli/                      # npm package: phone-terminal
│   ├── src/
│   │   ├── connect.ts        # main command, pty + stdin interception
│   │   ├── qr.ts
│   │   ├── ws-client.ts
│   │   ├── verify.ts         # local signature verification
│   │   ├── ui/status-box.ts
│   │   └── commands/ (disconnect.ts, devices.ts, revoke.ts, audit.ts)
│   └── package.json
├── backend/
│   ├── src/
│   │   ├── http/pair-init.ts
│   │   ├── ws/relay.ts
│   │   ├── ws/auth.ts
│   │   ├── redis/pairing-store.ts
│   │   ├── db/ (schema.sql, devices.ts, sessions.ts, audit.ts)
│   │   └── rate-limit.ts
│   └── package.json
├── phone-app/
│   ├── src/
│   │   ├── pages/ (Claim, Code, Connected, Disconnected)
│   │   ├── crypto/keypair.ts
│   │   ├── crypto/sign.ts
│   │   └── xterm/terminal-view.tsx
│   └── package.json
└── docs/
    └── phone-terminal-guide.md   # this document
```

---

*This document is the security-first source of truth for the build. Any implementation decision that weakens a guarantee stated here (e.g. "temporarily" allowing `ws://`, storing a private key server-side "just for debugging," or widening the verification-code attempt limit) should be treated as a regression, not a shortcut.*
