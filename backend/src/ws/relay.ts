/**
 * Control-phase message relay.
 *
 * Per §3.4:
 * - Phone → Backend → CLI: signed input/resize/disconnect envelopes
 * - CLI → Backend → Phone: unsigned output/status messages
 *
 * The backend does defense-in-depth signature verification before relaying
 * (per §1: "does not need to verify sig itself, but does anyway as
 * defense-in-depth against DoS-by-garbage").
 *
 * The CLI does its OWN verification independently — it never trusts the
 * backend's word about whether a message is authentic.
 *
 * Security:
 * - Backend verifies ECDSA P-256 signature before relaying (defense-in-depth)
 * - If sig verification fails, message is dropped (not relayed)
 * - 3 consecutive failures from a phone socket → force disconnect
 * - sessionId in the message must match the socket's bound session
 * - Output from CLI → phone is NOT signed (not a control channel)
 *   but is strictly scoped to the one sessionId/socket
 * - All messages are size-limited (16KB from WS handler)
 */

import { createVerify } from "node:crypto";
import type { WebSocket } from "@fastify/websocket";
import type pg from "pg";
import { SocketRegistry } from "./handler.js";
import { wsSend, wsError, type WsMessage } from "./router.js";

/** ECDSA P-256 public key in JWK format */
interface EcdsaPublicKeyJwk {
  kty: string;
  crv: string;
  x: string;
  y: string;
  [key: string]: unknown;
}

export interface RelayDeps {
  socketRegistry: SocketRegistry;
  pool: pg.Pool;
  log: (level: "info" | "warn" | "error", data: Record<string, unknown>, msg: string) => void;
}

/** Track consecutive signature failures per session (for auto-disconnect) */
const sigFailures = new Map<string, number>();

const MAX_CONSECUTIVE_SIG_FAILURES = 3;

/**
 * Verify an ECDSA P-256 signature on a control message.
 *
 * The signed data is: `sessionId|seq|ts|type|payload`
 * Per §2.5.
 */
export async function verifySignature(
  publicKeyJwk: EcdsaPublicKeyJwk,
  message: {
    sessionId: string;
    seq: number;
    ts: number;
    type: string;
    payload: unknown;
    sig: string;
  }
): Promise<boolean> {
  try {
    // Import the public key
    const keyObject = await import("node:crypto").then((crypto) =>
      crypto.createPublicKey({
        key: publicKeyJwk as Record<string, unknown>,
        format: "jwk",
      })
    );

    // Reconstruct the signed data
    const payloadStr = typeof message.payload === "string"
      ? message.payload
      : JSON.stringify(message.payload);
    const signedData = `${message.sessionId}|${message.seq}|${message.ts}|${message.type}|${payloadStr}`;

    // Verify signature
    const verify = createVerify("SHA256");
    verify.update(signedData);
    verify.end();

    const sigBuffer = Buffer.from(message.sig, "base64url");
    return verify.verify(keyObject, sigBuffer);
  } catch {
    return false;
  }
}

/**
 * Look up the public key for a session from Postgres.
 * Caches in memory after first lookup (key doesn't change during a session).
 */
const sessionKeyCache = new Map<string, EcdsaPublicKeyJwk>();

export async function getSessionPublicKey(
  pool: pg.Pool,
  sessionId: string
): Promise<EcdsaPublicKeyJwk | null> {
  // Check cache first
  const cached = sessionKeyCache.get(sessionId);
  if (cached) return cached;

  // Query Postgres
  const result = await pool.query(
    `SELECT d.public_key_jwk FROM sessions s
     JOIN devices d ON d.device_id = s.device_id
     WHERE s.session_id = $1 AND s.ended_at IS NULL AND d.revoked_at IS NULL`,
    [Buffer.from(sessionId, "base64url")]
  );

  if (result.rows.length === 0) return null;

  const jwk = result.rows[0]!.public_key_jwk as EcdsaPublicKeyJwk;
  sessionKeyCache.set(sessionId, jwk);
  return jwk;
}

/**
 * Clear the cached public key for a session (e.g., on revocation).
 */
export function clearSessionKeyCache(sessionId: string): void {
  sessionKeyCache.delete(sessionId);
}

/**
 * Handle a signed control message from the phone.
 * Verifies signature (defense-in-depth) then relays to CLI.
 *
 * Per §3.4: Phone → Backend (verify) → CLI
 */
export async function handlePhoneControlMessage(
  deps: RelayDeps,
  socket: WebSocket,
  message: WsMessage,
  ip: string
): Promise<void> {
  const sessionId = message["sessionId"];
  const seq = message["seq"];
  const ts = message["ts"];
  const type = message["type"];
  const payload = message["payload"];
  const sig = message["sig"];

  // Validate required fields
  if (
    typeof sessionId !== "string" ||
    typeof seq !== "number" ||
    typeof ts !== "number" ||
    typeof type !== "string" ||
    typeof sig !== "string"
  ) {
    wsError(socket, "invalid_control_message");
    return;
  }

  // Verify this socket is bound to this session
  const expectedSocket = deps.socketRegistry.getPhoneForSession(sessionId);
  if (expectedSocket !== socket) {
    wsError(socket, "session_mismatch");
    return;
  }

  // Look up public key
  const publicKeyJwk = await getSessionPublicKey(deps.pool, sessionId);
  if (!publicKeyJwk) {
    wsError(socket, "session_not_found");
    return;
  }

  // Defense-in-depth: verify signature
  const valid = await verifySignature(publicKeyJwk, {
    sessionId,
    seq,
    ts,
    type,
    payload,
    sig,
  });

  if (!valid) {
    // Track consecutive failures
    const failures = (sigFailures.get(sessionId) ?? 0) + 1;
    sigFailures.set(sessionId, failures);

    deps.log("warn", { ip, sessionId, failures, type }, "relay: signature verification failed");

    if (failures >= MAX_CONSECUTIVE_SIG_FAILURES) {
      deps.log("error", { ip, sessionId }, "relay: 3 consecutive sig failures — force disconnecting");
      // Force disconnect both sides
      deps.socketRegistry.removeSession(sessionId);
      sigFailures.delete(sessionId);
      // Mark session as ended in DB
      await deps.pool.query(
        `UPDATE sessions SET ended_at = NOW(), end_reason = 'sig_fail'
         WHERE session_id = $1 AND ended_at IS NULL`,
        [Buffer.from(sessionId, "base64url")]
      );
    }
    return; // Drop the message — do not relay
  }

  // Signature valid — reset failure counter
  sigFailures.delete(sessionId);

  // Relay to CLI socket
  const cliSocket = deps.socketRegistry.getCliForSession(sessionId);
  if (cliSocket) {
    // Forward the entire signed message — CLI will verify independently
    wsSend(cliSocket, message as Record<string, unknown>);
  }
}

/**
 * Handle an output/status message from the CLI.
 * No signature verification needed — output is not a control channel (§2.5).
 * Relay directly to the phone.
 *
 * Per §3.4: CLI → Backend → Phone
 */
export async function handleCliOutputMessage(
  deps: RelayDeps,
  socket: WebSocket,
  message: WsMessage,
  _ip: string
): Promise<void> {
  const sessionId = message["sessionId"];

  if (typeof sessionId !== "string") {
    wsError(socket, "invalid_output_message");
    return;
  }

  // Verify this socket is bound to this session
  const expectedSocket = deps.socketRegistry.getCliForSession(sessionId);
  if (expectedSocket !== socket) {
    wsError(socket, "session_mismatch");
    return;
  }

  // Relay to phone socket
  const phoneSocket = deps.socketRegistry.getPhoneForSession(sessionId);
  if (phoneSocket) {
    wsSend(phoneSocket, message as Record<string, unknown>);
  }
}
