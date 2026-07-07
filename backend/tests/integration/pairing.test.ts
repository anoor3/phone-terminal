/**
 * Integration tests: Pairing flow.
 *
 * These tests verify the complete pairing lifecycle as described in §3.3.
 * They require a running backend with Redis + Postgres.
 *
 * Run with: node --test backend/tests/integration/pairing.test.ts
 * (Requires: tsx or ts-node for TypeScript, or compile first)
 *
 * Prerequisites:
 * - Backend running on https://localhost:3001
 * - Redis running on localhost:6379
 * - Postgres running with migrations applied
 * - Valid TLS certs (mkcert)
 */

import { describe, it } from "node:test";

// ---------------------------------------------------------------------------
// Test configuration
// ---------------------------------------------------------------------------

const API_BASE = process.env["TEST_API_URL"] ?? "https://localhost:3001";
const WS_URL = process.env["TEST_WS_URL"] ?? "wss://localhost:3001/ws";

// ---------------------------------------------------------------------------
// Test: Full pairing flow
// ---------------------------------------------------------------------------

describe("Pairing Flow", () => {
  describe("happy path: pair/init → WS connect → cli_hello → phone_claim → code_submit → paired", () => {
    it("should successfully complete the full pairing flow", async () => {
      // TODO: Implementation
      //
      // Steps:
      // 1. POST /api/pair/init → get { pairingId, pairingToken, cliSecret, expiresAt }
      // 2. Open WSS connection as CLI
      // 3. Send cli_hello { pairingId, cliSecret }
      // 4. Verify cli_hello_ack received
      // 5. Open second WSS connection as phone
      // 6. Send phone_claim { pairingId, pairingToken }
      // 7. Verify phone_claim_ack received on phone socket
      // 8. Verify phone_claimed event received on CLI socket
      // 9. CLI generates and displays 6-digit code
      // 10. Phone sends code_submit { pairingId, code }
      // 11. Verify paired event received on both sockets with sessionId
      //
      // Assertions:
      // - All messages received in correct order
      // - sessionId is a valid base64url string
      // - Both sockets transition to control phase
    });

    it("should reject cli_hello with wrong cliSecret", async () => {
      // TODO: Implementation
      //
      // Steps:
      // 1. POST /api/pair/init → get { pairingId, cliSecret }
      // 2. Open WSS connection
      // 3. Send cli_hello { pairingId, cliSecret: "wrong-secret" }
      //
      // Assertions:
      // - Error response received
      // - Socket closed by server
    });

    it("should reject phone_claim with wrong pairingToken", async () => {
      // TODO: Implementation
      //
      // Steps:
      // 1. POST /api/pair/init → get { pairingId, pairingToken }
      // 2. Open WSS as CLI, send cli_hello (valid)
      // 3. Open WSS as phone
      // 4. Send phone_claim { pairingId, pairingToken: "wrong-token" }
      //
      // Assertions:
      // - Error response received
      // - Phone socket closed
    });
  });

  // ---------------------------------------------------------------------------
  // Test: Replay QR URL after pairing
  // ---------------------------------------------------------------------------

  describe("replay protection: QR URL reuse after pairing", () => {
    it("should reject phone_claim with already-claimed pairingId", async () => {
      // TODO: Implementation
      //
      // Steps:
      // 1. Complete full pairing flow (pair/init → paired)
      // 2. Open a new WSS connection as second phone
      // 3. Send phone_claim with the same { pairingId, pairingToken }
      //
      // Assertions:
      // - Error response: "already_claimed" or similar
      // - Second phone socket closed
      // - Original session unaffected
    });

    it("should reject pair/init token after expiry (120s)", async () => {
      // TODO: Implementation
      //
      // Note: This test would need time manipulation or a very short TTL
      // in test config. Alternatively, directly test the Redis TTL behavior.
      //
      // Steps:
      // 1. POST /api/pair/init → get { pairingId, expiresAt }
      // 2. Wait for expiry (or mock time)
      // 3. Attempt phone_claim with the expired pairingId
      //
      // Assertions:
      // - Error response: "expired" or "not_found"
    });
  });

  // ---------------------------------------------------------------------------
  // Test: Brute-force code attempts
  // ---------------------------------------------------------------------------

  describe("brute-force protection: verification code attempt limit", () => {
    it("should lock after 5 failed code attempts", async () => {
      // TODO: Implementation
      //
      // Steps:
      // 1. Complete up to phone_claimed state (CLI has code, phone has input)
      // 2. Phone sends code_submit with wrong code — attempt 1
      // 3. Verify error: "invalid_code" and attempts_remaining: 4
      // 4. Repeat with wrong codes — attempts 2, 3, 4, 5
      // 5. Verify on 5th failure: session is locked/terminated
      //
      // Assertions:
      // - Attempts 1-4: error with decreasing attempts_remaining
      // - Attempt 5: pairing is terminated, both sockets notified
      // - Attempt 6: any further code_submit gets "locked" error
    });

    it("should accept correct code on attempt 4 of 5", async () => {
      // TODO: Implementation
      //
      // Steps:
      // 1. Complete up to phone_claimed state
      // 2. Phone sends 3 wrong codes (attempts 1-3)
      // 3. Phone sends correct code on attempt 4
      //
      // Assertions:
      // - Attempts 1-3: error with decreasing attempts_remaining
      // - Attempt 4 (correct): paired event received
      // - Session is active
    });
  });

  // ---------------------------------------------------------------------------
  // Test: Signature verification (modified payload)
  // ---------------------------------------------------------------------------

  describe("signature verification: modified payload rejection", () => {
    it("should reject control message with invalid signature", async () => {
      // TODO: Implementation
      //
      // Steps:
      // 1. Complete full pairing flow (get to control phase)
      // 2. Generate an ECDSA P-256 keypair (matching what phone registered)
      // 3. Create a valid signed envelope: { sessionId, seq: 1, ts, type: "input", payload: "ls" }
      // 4. Modify one byte of the payload AFTER signing
      // 5. Send the tampered message from the phone socket
      //
      // Assertions:
      // - Message is NOT relayed to CLI
      // - Error response on phone socket (or silent drop)
      // - After 3 consecutive failures: force disconnect (per §2.5)
    });

    it("should reject control message with wrong session's key", async () => {
      // TODO: Implementation
      //
      // Steps:
      // 1. Complete full pairing flow
      // 2. Generate a DIFFERENT keypair (not the one registered)
      // 3. Sign a message with the wrong key
      // 4. Send from the phone socket
      //
      // Assertions:
      // - Signature verification fails
      // - Message dropped
    });

    it("should reject replayed envelope (same seq number)", async () => {
      // TODO: Implementation
      //
      // Steps:
      // 1. Complete full pairing flow
      // 2. Send a valid signed message with seq: 1
      // 3. Send the EXACT same message again (seq: 1 reused)
      //
      // Assertions:
      // - First message: relayed successfully
      // - Second message: rejected (sequence number reuse)
      //
      // Note: seq rejection happens at CLI side (per §2.5), but backend
      // may also enforce monotonic seq as defense-in-depth.
    });
  });

  // ---------------------------------------------------------------------------
  // Test: Dual-claim protection
  // ---------------------------------------------------------------------------

  describe("dual-claim: only first phone succeeds", () => {
    it("should reject second phone_claim for same pairingId", async () => {
      // TODO: Implementation
      //
      // Steps:
      // 1. POST /api/pair/init
      // 2. CLI sends cli_hello (valid)
      // 3. Phone A sends phone_claim (valid) → claimed
      // 4. Phone B opens new connection, sends phone_claim (same pairingId + token)
      //
      // Assertions:
      // - Phone A: phone_claim_ack received
      // - Phone B: error "already_claimed"
      // - Only Phone A can submit code
    });
  });

  // ---------------------------------------------------------------------------
  // Test: Origin validation
  // ---------------------------------------------------------------------------

  describe("origin validation: reject unknown origins", () => {
    it("should reject WebSocket connection with invalid Origin header", async () => {
      // TODO: Implementation
      //
      // Steps:
      // 1. Open WSS connection with Origin: "https://evil.example.com"
      //
      // Assertions:
      // - Connection rejected at handshake (close code 1008)
      // - No messages can be sent
    });
  });
});
