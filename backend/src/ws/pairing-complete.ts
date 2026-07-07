/**
 * Pairing completion — finalizes the pairing flow after code verification.
 *
 * Per §2.4:
 * 1. Generate sessionId (32 random bytes) + deviceId (32 random bytes)
 * 2. Store { sessionId, deviceId, publicKeyJwk, label } in Postgres
 * 3. Send CLI a 'paired' event with publicKeyJwk (CLI stores its own copy)
 * 4. Send phone a 'paired' event with sessionId
 * 5. Delete pairing Redis keys (no lingering state)
 * 6. Promote sockets from pairing-phase to session-phase in SocketRegistry
 *
 * Security:
 * - sessionId/deviceId are 32 random bytes (not sequential/guessable)
 * - CLI receives publicKeyJwk and stores locally — does NOT trust backend
 *   to re-tell it who's paired on every subsequent message
 * - Pairing Redis keys destroyed immediately (token/code/state gone)
 * - Audit log records 'paired' event as first entry in hash chain
 */

import { randomBytes } from "node:crypto";
import type { WebSocket } from "@fastify/websocket";
import type pg from "pg";
import type { PairingStore } from "../db/pairing-store.js";
import { SocketRegistry } from "./handler.js";
import { wsSend } from "./router.js";

export interface PairingCompletionDeps {
  pairingStore: PairingStore;
  socketRegistry: SocketRegistry;
  pool: pg.Pool;
  log: (level: "info" | "warn" | "error", data: Record<string, unknown>, msg: string) => void;
}

/**
 * Complete the pairing process after code verification succeeds.
 *
 * This is the transition from "pairing session" to "control session" —
 * two logically distinct concepts per §1.
 */
export async function completePairing(
  deps: PairingCompletionDeps,
  pairingId: string,
  publicKeyJwk: Record<string, unknown>,
  deviceLabel: string,
  cliInstance: string
): Promise<void> {
  // 1. Generate cryptographically random IDs
  const sessionId = randomBytes(32);
  const deviceId = randomBytes(32);
  const sessionIdB64 = sessionId.toString("base64url");
  const deviceIdB64 = deviceId.toString("base64url");

  // 2. Store device + session in Postgres (single transaction)
  const client = await deps.pool.connect();
  try {
    await client.query("BEGIN");

    // Insert device record
    await client.query(
      `INSERT INTO devices (device_id, public_key_jwk, label, cli_instance, created_at)
       VALUES ($1, $2, $3, $4, NOW())`,
      [deviceId, JSON.stringify(publicKeyJwk), deviceLabel, cliInstance]
    );

    // Insert session record
    await client.query(
      `INSERT INTO sessions (session_id, device_id, cli_instance, paired_at)
       VALUES ($1, $2, $3, NOW())`,
      [sessionId, deviceId, cliInstance]
    );

    // Insert first audit log entry (start of hash chain)
    const detail = JSON.stringify({
      deviceId: deviceIdB64,
      deviceLabel,
      cliInstance,
    });
    const { createHash } = await import("node:crypto");
    const rowHash = createHash("sha256")
      .update(`null|paired|${detail}|${new Date().toISOString()}`)
      .digest("hex");

    await client.query(
      `INSERT INTO audit_log (session_id, event_type, detail, prev_hash, row_hash)
       VALUES ($1, 'paired', $2, NULL, $3)`,
      [sessionId, detail, rowHash]
    );

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    deps.log("error", { pairingId, error: (err as Error).message }, "completePairing: DB transaction failed");
    throw err;
  } finally {
    client.release();
  }

  // 3. Send 'paired' event to CLI (includes publicKeyJwk — CLI stores its own copy)
  const cliSocket = deps.socketRegistry.getCliForPairing(pairingId);
  if (cliSocket) {
    wsSend(cliSocket, {
      type: "paired",
      sessionId: sessionIdB64,
      deviceId: deviceIdB64,
      deviceLabel,
      publicKeyJwk,
    });
  }

  // 4. Send 'paired' event to phone (does NOT include publicKeyJwk — phone already has the private key)
  const phoneSocket = deps.socketRegistry.getPhoneForPairing(pairingId);
  if (phoneSocket) {
    wsSend(phoneSocket, {
      type: "paired",
      sessionId: sessionIdB64,
      deviceId: deviceIdB64,
    });
  }

  // 5. Promote sockets from pairing-phase to session-phase
  deps.socketRegistry.promoteToSession(pairingId, sessionIdB64);

  // 6. Destroy all pairing Redis keys (token, code, attempts, state — all gone)
  await deps.pairingStore.destroy(pairingId);

  deps.log("info", {
    pairingId,
    sessionId: sessionIdB64,
    deviceId: deviceIdB64,
    deviceLabel,
  }, "completePairing: pairing complete — control session active");
}
