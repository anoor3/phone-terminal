/**
 * CLI local signature verification.
 *
 * Per §2.5:
 * - ECDSA P-256 signature verification against stored public key
 * - Signed data: `sessionId|seq|ts|type|payload`
 * - ts must be within ±30s of local clock
 * - seq must be strictly greater than last accepted seq (monotonic)
 * - sessionId must match the current session
 * - 3 consecutive failures → auto-disconnect + red alert
 *
 * This is THE critical security boundary. Even if the backend is fully
 * compromised, the CLI rejects messages that don't carry a valid signature
 * from the phone's private key.
 *
 * Security:
 * - CLI does NOT trust the backend's signature check
 * - CLI verifies INDEPENDENTLY against its own copy of the public key
 * - A single failure does NOT kill the session (could be network jitter)
 * - 3 consecutive failures = likely tampering → auto-disconnect + alert
 * - Stale timestamps rejected (anti-replay within clock drift tolerance)
 * - Sequence numbers monotonically increasing (anti-replay for reordered msgs)
 */

import { createPublicKey, verify as cryptoVerify } from "node:crypto";
import type { SessionState } from "./session.js";

const TIMESTAMP_TOLERANCE_MS = 30_000; // ±30 seconds
const MAX_CONSECUTIVE_FAILURES = 3;

export interface SignedEnvelope {
  sessionId: string;
  seq: number;
  ts: number;
  type: string;
  payload: unknown;
  sig: string;
}

export type VerificationResult =
  | { valid: true; payload: unknown; type: string }
  | { valid: false; reason: string };

/**
 * Verify a signed message envelope from the phone.
 *
 * Returns { valid: true, payload, type } on success, or
 * { valid: false, reason } explaining why verification failed.
 *
 * Updates session state (lastSeq, consecutiveSigFailures).
 */
export function verifyMessage(
  state: SessionState,
  envelope: SignedEnvelope
): VerificationResult {
  // 1. Session ID must match
  if (envelope.sessionId !== state.sessionId) {
    return recordFailure(state, "session_id_mismatch");
  }

  // 2. Timestamp freshness: must be within ±30s of local clock
  const now = Date.now();
  const drift = Math.abs(now - envelope.ts);
  if (drift > TIMESTAMP_TOLERANCE_MS) {
    return recordFailure(state, `timestamp_stale (drift: ${drift}ms, max: ${TIMESTAMP_TOLERANCE_MS}ms)`);
  }

  // 3. Sequence number must be strictly greater than last accepted
  if (envelope.seq <= state.lastSeq) {
    return recordFailure(state, `seq_not_monotonic (got: ${envelope.seq}, last: ${state.lastSeq})`);
  }

  // 4. Verify ECDSA P-256 signature
  const sigValid = verifyEcdsaSignature(state.publicKeyJwk, envelope);
  if (!sigValid) {
    return recordFailure(state, "signature_invalid");
  }

  // All checks passed — reset failure counter, update lastSeq
  state.consecutiveSigFailures = 0;
  state.lastSeq = envelope.seq;

  return { valid: true, payload: envelope.payload, type: envelope.type };
}

/**
 * Verify an ECDSA P-256 signature.
 * Signed data format: `sessionId|seq|ts|type|payload`
 */
function verifyEcdsaSignature(
  publicKeyJwk: Record<string, unknown>,
  envelope: SignedEnvelope
): boolean {
  try {
    // Import the public key from JWK
    const keyObject = createPublicKey({
      key: publicKeyJwk as Record<string, unknown> & { kty: string },
      format: "jwk",
    });

    // Reconstruct the exact signed data
    const payloadStr = typeof envelope.payload === "string"
      ? envelope.payload
      : JSON.stringify(envelope.payload);
    const signedData = `${envelope.sessionId}|${envelope.seq}|${envelope.ts}|${envelope.type}|${payloadStr}`;

    const sigBuffer = Buffer.from(envelope.sig, "base64url");

    // WebCrypto ECDSA produces IEEE P1363 format (r||s, 64 bytes for P-256)
    return cryptoVerify(
      "SHA256",
      Buffer.from(signedData),
      { key: keyObject, dsaEncoding: "ieee-p1363" },
      sigBuffer
    );
  } catch {
    // Any crypto error = invalid
    return false;
  }
}

/**
 * Record a verification failure. Returns the failure result.
 * If 3 consecutive failures reached, triggers auto-disconnect.
 */
function recordFailure(state: SessionState, reason: string): VerificationResult {
  state.consecutiveSigFailures++;

  if (state.consecutiveSigFailures >= MAX_CONSECUTIVE_FAILURES) {
    // This will be caught by the caller to trigger auto-disconnect
    return { valid: false, reason: `AUTO_DISCONNECT: ${reason} (${state.consecutiveSigFailures} consecutive failures)` };
  }

  return { valid: false, reason };
}

/**
 * Check if the latest failure should trigger auto-disconnect.
 */
export function shouldAutoDisconnect(state: SessionState): boolean {
  return state.consecutiveSigFailures >= MAX_CONSECUTIVE_FAILURES;
}

/**
 * Parse a raw WebSocket message into a SignedEnvelope.
 * Returns null if the message is not a valid signed envelope.
 */
export function parseSignedEnvelope(raw: string): SignedEnvelope | null {
  try {
    const msg: unknown = JSON.parse(raw);
    if (typeof msg !== "object" || msg === null) return null;

    const obj = msg as Record<string, unknown>;

    if (
      typeof obj["sessionId"] !== "string" ||
      typeof obj["seq"] !== "number" ||
      typeof obj["ts"] !== "number" ||
      typeof obj["type"] !== "string" ||
      typeof obj["sig"] !== "string"
    ) {
      return null;
    }

    return {
      sessionId: obj["sessionId"] as string,
      seq: obj["seq"] as number,
      ts: obj["ts"] as number,
      type: obj["type"] as string,
      payload: obj["payload"],
      sig: obj["sig"] as string,
    };
  } catch {
    return null;
  }
}
