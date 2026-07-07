/**
 * Verification code generation and validation.
 *
 * Per §2.3:
 * - 6-digit numeric code, generated server-side using CSPRNG
 * - Pushed to phone via live WebSocket (NOT in QR — that would leak it in photos)
 * - Max 5 attempts per pairingId, then the whole pairing is invalidated
 * - Code is NEVER a bearer credential after this step — discarded on pairing complete
 *
 * Flow:
 * 1. After phone_claim succeeds → generateAndPushCode()
 * 2. Phone displays code → user reads it
 * 3. User types code into CLI → CLI sends code_submit
 * 4. Backend validates code (constant-time) → returns result
 *
 * Security:
 * - Code generated from crypto.randomInt (not Math.random)
 * - Constant-time comparison prevents timing-based attacks
 * - Attempt counter incremented BEFORE comparison (prevents race condition)
 * - After 5 failed attempts: entire pairing session destroyed
 * - Code has same 120s TTL as the pairing session
 */

import { randomInt } from "node:crypto";
import type { WebSocket } from "@fastify/websocket";
import type { PairingStore } from "../db/pairing-store.js";
import { SocketRegistry } from "./handler.js";
import { wsSend, wsError } from "./router.js";

export interface CodeHandlerDeps {
  pairingStore: PairingStore;
  socketRegistry: SocketRegistry;
  log: (level: "info" | "warn" | "error", data: Record<string, unknown>, msg: string) => void;
  onCodeValid: (pairingId: string) => Promise<void>;
}

/**
 * Generate a cryptographically random 6-digit code.
 * Uses crypto.randomInt for uniform distribution (not Math.random).
 */
function generateCode(): string {
  // Generate number between 0 and 999999 inclusive
  const num = randomInt(0, 1_000_000);
  // Pad to always be 6 digits (e.g. 42 → "000042")
  return num.toString().padStart(6, "0");
}

/**
 * Generate a verification code and push it to the phone.
 * Called immediately after phone_claim succeeds.
 */
export async function generateAndPushCode(
  deps: CodeHandlerDeps,
  pairingId: string
): Promise<boolean> {
  const code = generateCode();

  // Store code in Redis with 120s TTL
  const stored = await deps.pairingStore.setCode(pairingId, code);
  if (!stored) {
    deps.log("error", { pairingId }, "code: failed to store code — pairing may have expired");
    return false;
  }

  // Push code_challenge to phone via its WebSocket
  const phoneSocket = deps.socketRegistry.getPhoneForPairing(pairingId);
  if (!phoneSocket) {
    deps.log("error", { pairingId }, "code: no phone socket found for pairing");
    return false;
  }

  wsSend(phoneSocket, {
    type: "code_challenge",
    code,
  });

  deps.log("info", { pairingId }, "code: verification code generated and pushed to phone");
  return true;
}

/**
 * Handle a code_submit message from the CLI.
 * Validates the submitted code and returns the result.
 *
 * Per §2.3: max 5 attempts, then invalidate the entire pairing.
 */
export async function handleCodeSubmit(
  deps: CodeHandlerDeps,
  socket: WebSocket,
  pairingId: string,
  code: string,
  ip: string
): Promise<void> {
  // Validate the code (constant-time comparison inside PairingStore)
  const result = await deps.pairingStore.validateCode(pairingId, code);

  switch (result) {
    case "valid": {
      deps.log("info", { ip, pairingId }, "code_submit: valid — proceeding to pairing completion");

      // Tell CLI the code was accepted
      wsSend(socket, {
        type: "code_valid",
        pairingId,
      });

      // Also notify the phone
      const phoneSocket = deps.socketRegistry.getPhoneForPairing(pairingId);
      if (phoneSocket) {
        wsSend(phoneSocket, {
          type: "code_valid",
          pairingId,
        });
      }

      // Trigger pairing completion
      await deps.onCodeValid(pairingId);
      break;
    }

    case "invalid": {
      const remaining = await deps.pairingStore.getRemainingAttempts(pairingId);
      deps.log("warn", { ip, pairingId, remaining }, "code_submit: invalid code");

      wsSend(socket, {
        type: "code_invalid",
        pairingId,
        remaining,
      });
      break;
    }

    case "locked": {
      deps.log("warn", { ip, pairingId }, "code_submit: max attempts exceeded — invalidating pairing");

      // Destroy the entire pairing session
      await deps.pairingStore.destroy(pairingId);

      // Tell CLI to show a fresh QR
      wsSend(socket, {
        type: "code_locked",
        pairingId,
        error: "Maximum attempts exceeded. Run 'connect' again for a new QR code.",
      });

      // Close the phone socket
      const phoneSocket = deps.socketRegistry.getPhoneForPairing(pairingId);
      if (phoneSocket) {
        wsSend(phoneSocket, {
          type: "code_locked",
          pairingId,
          error: "Maximum attempts exceeded. Pairing has been invalidated.",
        });
        phoneSocket.close(1000, "code_locked");
      }

      // Close the CLI socket too (forces fresh start)
      socket.close(1000, "code_locked");
      break;
    }

    case "expired": {
      deps.log("warn", { ip, pairingId }, "code_submit: pairing expired");
      wsError(socket, "pairing_expired", true);
      break;
    }
  }
}
