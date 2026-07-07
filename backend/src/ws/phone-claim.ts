/**
 * phone_claim handler — Phone claims a pairing session with the token from the QR code.
 *
 * Per §2.2 and §3.2:
 * - Phone sends: { type: "phone_claim", pairingId, pairingToken }
 * - Token was read from URL fragment (never hit server logs)
 * - Backend validates token (constant-time) and transitions state to "claimed"
 * - Token is SINGLE-USE: deleted immediately on successful claim
 * - Only the FIRST phone to claim succeeds — prevents race conditions
 *
 * Security:
 * - Constant-time token comparison (via PairingStore.claim())
 * - Atomic state transition (pending → claimed) prevents dual-claim
 * - Token deleted from Redis on success — can never be reused
 * - Second phone attempting same pairingId gets "already_claimed" error
 * - Failed claims logged with IP for abuse detection
 * - Pairing must exist and not be expired (120s TTL)
 */

import type { WebSocket } from "@fastify/websocket";
import type { PairingStore } from "../redis/pairing-store.js";
import { SocketRegistry } from "./handler.js";
import { wsSend, wsError } from "./router.js";

export interface PhoneClaimHandlerDeps {
  pairingStore: PairingStore;
  socketRegistry: SocketRegistry;
  log: (level: "info" | "warn" | "error", data: Record<string, unknown>, msg: string) => void;
}

/**
 * Handle a phone_claim message.
 * Validates the pairing token and claims the session.
 */
export async function handlePhoneClaim(
  deps: PhoneClaimHandlerDeps,
  socket: WebSocket,
  pairingId: string,
  pairingToken: string,
  ip: string
): Promise<void> {
  // 1. Check pairing session exists
  const state = await deps.pairingStore.getState(pairingId);
  if (!state) {
    deps.log("warn", { ip, pairingId }, "phone_claim: pairing session not found or expired");
    wsError(socket, "pairing_expired", true);
    return;
  }

  // 2. Check not already claimed
  if (state === "claimed") {
    deps.log("warn", { ip, pairingId }, "phone_claim: session already claimed by another phone");
    wsError(socket, "already_claimed", true);
    return;
  }

  // 3. Validate token and atomically claim (constant-time comparison + atomic state transition)
  const claimed = await deps.pairingStore.claim(pairingId, pairingToken);
  if (!claimed) {
    deps.log("warn", { ip, pairingId }, "phone_claim: invalid token or claim race lost");
    wsError(socket, "claim_failed", true);
    return;
  }

  // 4. Check no existing phone socket for this pairingId
  const existing = deps.socketRegistry.getPhoneForPairing(pairingId);
  if (existing) {
    deps.log("warn", { ip, pairingId }, "phone_claim: phone already connected for this pairing");
    wsError(socket, "already_connected", true);
    return;
  }

  // 5. Bind socket to pairing session
  deps.socketRegistry.setPhoneForPairing(pairingId, socket);

  deps.log("info", { ip, pairingId }, "phone_claim: phone claimed pairing session");

  // 6. Acknowledge success to phone
  wsSend(socket, {
    type: "phone_claim_ack",
    pairingId,
  });

  // 7. Notify CLI that a phone has claimed (so it can update its UI)
  const cliSocket = deps.socketRegistry.getCliForPairing(pairingId);
  if (cliSocket) {
    wsSend(cliSocket, {
      type: "phone_claimed",
      pairingId,
    });
  }
}
