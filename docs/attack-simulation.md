# Attack Simulation Checklist

Full adversarial testing checklist for phone-terminal (per §11 of the security specification).

Run these manually against a local dev instance. Every check must pass before deployment.

---

## 1. Replay QR URL after pairing

- **What to test:** Scan (or open) the same QR pairing URL after the session is already paired.
- **Expected result:** Phone receives an error ("already\_claimed" or "expired"). No new session is created.
- **How to verify:**
  1. Complete a full pairing flow.
  2. Copy the QR URL (or photograph it).
  3. Open the URL in a new browser tab.
  4. Observe: phone\_claim is rejected; the existing session is unaffected.

- [ ] **PASS**

---

## 2. Screenshot code after 120s

- **What to test:** Wait for the pairing token to expire (120s TTL), then attempt to use the captured verification code.
- **Expected result:** Backend rejects the code\_submit because the pairing record has been evicted from Redis (TTL expired).
- **How to verify:**
  1. Initiate pairing (POST /api/pair/init).
  2. Wait 121+ seconds without completing pairing.
  3. Attempt phone\_claim with the original pairingToken.
  4. Observe: "not\_found" or "expired" error.

- [ ] **PASS**

---

## 3. Brute-force 6+ code attempts

- **What to test:** Submit more than 5 incorrect verification codes.
- **Expected result:** After 5 failed attempts, the pairing is locked/terminated. The 6th attempt receives a "locked" error.
- **How to verify:**
  1. Complete pairing up to the code entry stage.
  2. Submit 5 different wrong codes.
  3. Observe: 5th failure terminates the pairing.
  4. Submit a 6th code (even the correct one).
  5. Observe: rejected with "locked" — cannot recover.

- [ ] **PASS**

---

## 4. Dual-claim same pairingId

- **What to test:** Two phones attempt to claim the same pairing session.
- **Expected result:** Only the first phone\_claim succeeds. The second receives "already\_claimed".
- **How to verify:**
  1. POST /api/pair/init → get pairingId + pairingToken.
  2. CLI sends cli\_hello (valid).
  3. Phone A sends phone\_claim → receives phone\_claim\_ack.
  4. Phone B sends phone\_claim (same pairingId + pairingToken) → receives error.
  5. Observe: only Phone A can proceed to code submission.

- [ ] **PASS**

---

## 5. Replay valid signed envelope

- **What to test:** Capture a valid signed control message and resend it (replay).
- **Expected result:** The replayed message is rejected because the sequence number has already been consumed (monotonic seq enforcement).
- **How to verify:**
  1. Complete pairing and enter control phase.
  2. Send a valid signed input message (seq: 1).
  3. Observe: message relayed, command executed.
  4. Resend the exact same message (seq: 1 again).
  5. Observe: CLI rejects it (seq must be > last seen seq).

- [ ] **PASS**

---

## 6. Modify byte in signed payload

- **What to test:** Intercept a signed message, alter one byte of the payload, and forward it.
- **Expected result:** ECDSA signature verification fails. Message is dropped (not relayed to CLI).
- **How to verify:**
  1. Complete pairing and enter control phase.
  2. Construct a valid signed message: `{ type: "input", payload: "ls", sig: "..." }`.
  3. Change payload to "rm" (but keep the original signature).
  4. Send the tampered message.
  5. Observe: backend drops the message (defense-in-depth). CLI never receives it.
  6. After 3 consecutive failures: session is force-disconnected.

- [ ] **PASS**

---

## 7. Kill CLI with -9

- **What to test:** Force-kill the CLI process (simulating crash, power loss, or `kill -9`).
- **Expected result:** Backend detects the socket close within seconds and marks the session as ended (`end_reason: 'terminal_closed'`).
- **How to verify:**
  1. Complete pairing and enter control phase.
  2. Find the CLI PID: `ps aux | grep phone-terminal`.
  3. Kill it: `kill -9 <pid>`.
  4. Observe: backend logs "session ended" with reason "terminal\_closed".
  5. Phone receives disconnect notification.
  6. Postgres: `SELECT ended_at, end_reason FROM sessions WHERE ...` shows the session is ended.

- [ ] **PASS**

---

## 8. Revoke while connected

- **What to test:** Issue a revoke command while a session is actively connected.
- **Expected result:** Session is terminated within one WebSocket round-trip (~50ms). Both sides are notified with reason "revoked".
- **How to verify:**
  1. Complete pairing and enter control phase.
  2. Call the revoke endpoint (or use CLI revoke command).
  3. Observe: both sockets receive `{ type: "disconnect", reason: "revoked" }`.
  4. Observe: both sockets are closed.
  5. Verify session is marked ended in Postgres.

- [ ] **PASS**

---

## 9. Wrong Origin header

- **What to test:** Connect to the WebSocket endpoint with a forged or unknown Origin header.
- **Expected result:** Connection is rejected at the WebSocket handshake (close code 1008, reason "invalid\_origin").
- **How to verify:**
  1. Use wscat or a custom script to connect with: `Origin: https://evil.example.com`.
  2. Observe: connection is immediately closed by server.
  3. Verify server logs show "WS connection rejected: invalid Origin".

```bash
# Example with wscat:
wscat -c wss://localhost:3001/ws --header "Origin: https://evil.example.com"
# Expected: connection closed immediately
```

- [ ] **PASS**

---

## 10. ws:// instead of wss://

- **What to test:** Attempt to connect using plaintext WebSocket (`ws://`) instead of `wss://`.
- **Expected result:** Connection is impossible — no HTTP (non-TLS) listener exists. The server only binds an HTTPS socket.
- **How to verify:**
  1. Attempt: `wscat -c ws://localhost:3001/ws`
  2. Observe: "connection refused" or timeout (no listener on that port/protocol).
  3. Verify with `scripts/check-no-plaintext-ws.sh` — no `ws://` code paths exist in source.
  4. Verify backend config: `TLS_CERT_PATH` and `TLS_KEY_PATH` are required (server won't start without them).

```bash
# This must fail:
wscat -c ws://localhost:3001/ws
# Expected: ECONNREFUSED or timeout

# Verify no code paths:
./scripts/check-no-plaintext-ws.sh
# Expected: "✓ No plaintext ws:// found in source code."
```

- [ ] **PASS**

---

## 11. Obfuscated dangerous commands

- **What to test:** Send commands with Unicode zero-width characters or other obfuscation to bypass the dangerous command filter (e.g., `s\u200Budo rm -rf /`).
- **Expected result:** **Documented limitation.** The current dangerous command detection uses pattern matching on the plaintext command string. Zero-width characters inserted between letters will bypass the filter.
- **How to verify:**
  1. Complete pairing and enter control phase.
  2. Send an input with payload: `s\u200Budo rm -rf /` (zero-width space in "sudo").
  3. Observe: the command passes the dangerous command filter (not flagged).
  4. Note: this is a **known limitation**, not a bug.

**Mitigations (defense-in-depth):**
- The CLI still requires user confirmation for flagged commands (on the laptop).
- The laptop user can see all commands executing in real-time (status box).
- Commands run with the CLI process's permissions (not elevated).
- Future: normalize Unicode before pattern matching, or use shell parsing.

- [ ] **ACKNOWLEDGED (documented limitation)**

---

## Summary

| # | Attack | Expected Outcome | Status |
|---|--------|-----------------|--------|
| 1 | Replay QR URL | Rejected (already claimed) | ⬜ |
| 2 | Expired token | Rejected (TTL elapsed) | ⬜ |
| 3 | Brute-force code | Locked at 5 attempts | ⬜ |
| 4 | Dual-claim | Only first succeeds | ⬜ |
| 5 | Replay envelope | Seq reuse rejected | ⬜ |
| 6 | Modified payload | Sig fails, dropped | ⬜ |
| 7 | Kill CLI -9 | Session marked ended | ⬜ |
| 8 | Revoke while connected | Dropped in one RTT | ⬜ |
| 9 | Wrong Origin | Rejected at handshake | ⬜ |
| 10 | ws:// connection | Impossible (no listener) | ⬜ |
| 11 | Obfuscated commands | Documented limitation | ⬜ |

All checks marked ⬜ must be verified before production deployment.
