/**
 * cli_hello handler — CLI authenticates its WebSocket for a pairing session.
 *
 * Per §3.2 and §4.3:
 * - CLI sends: { type: "cli_hello", pairingId, cliSecret }
 * - Backend validates cliSecret against what was stored at /api/pair/init
 * - On success: binds this socket to the pairingId in the SocketRegistry
 * - On failure: closes the socket immediately
 *
 * Security:
 * - cliSecret validated with constant-time comparison (via PairingStore)
 * - Pairing session must exist and not be expired (120s TTL enforced by Redis)
 * - Only ONE CLI socket per pairingId — prevents duplicate connections
 * - Failed auth attempts logged with IP for abuse detection
 */

import type { WebSocket } from "@fastify/websocket";
import type { PairingStore } from "../redis/pairing-store.js";
import { SocketRegistry } from "./handler.js";
import { wsSend, wsError } from "./router.js";

export interface CliHelloHandlerDeps {
  pairingStore: PairingStore;
  socketRegistry: SocketRegistry;
  log: (level: "info" | "warn" | "error", data: Record<string, unknown>, msg: string) => void;
}

/**
 * Handle a cli_hello message.
 * Validates the cliSecret and binds the socket to the pairing session.
 */
export async function handleCliHello(
  deps: CliHelloHandlerDeps,
  socket: WebSocket,
  pairingId: string,
  cliSecret: string,
  ip: string
): Promise<void> {
  // 1. Check pairing session exists
  const state = await deps.pairingStore.getState(pairingId);
  if (!state) {
    deps.log("warn", { ip, pairingId }, "cli_hello: pairing session not found or expired");
    wsError(socket, "pairing_expired", true);
    return;
  }

  // 2. Validate cliSecret (constant-time comparison)
  const valid = await deps.pairingStore.validateCliSecret(pairingId, cliSecret);
  if (!valid) {
    deps.log("warn", { ip, pairingId }, "cli_hello: invalid cliSecret");
    wsError(socket, "auth_failed", true);
    return;
  }

  // 3. Check no existing CLI socket for this pairingId
  const existing = deps.socketRegistry.getCliForPairing(pairingId);
  if (existing) {
    deps.log("warn", { ip, pairingId }, "cli_hello: CLI already connected for this pairing");
    wsError(socket, "already_connected", true);
    return;
  }

  // 4. Bind socket to pairing session
  deps.socketRegistry.setCliForPairing(pairingId, socket);

  deps.log("info", { ip, pairingId }, "cli_hello: CLI authenticated and bound to pairing");

  // 5. Acknowledge success
  wsSend(socket, {
    type: "cli_hello_ack",
    pairingId,
    state, // "pending" or "claimed" — tells CLI if phone already claimed
  });
}
