/**
 * POST /api/pair/init — Start a new pairing session.
 *
 * Called by the CLI to begin the pairing flow. Returns:
 *   - pairingId: identifies this pairing attempt
 *   - pairingToken: embedded in QR code URL fragment by the CLI
 *   - cliSecret: proves this CLI process owns this pairing (for WS auth)
 *   - expiresAt: when the pairing window closes (120s from now)
 *
 * Security:
 *   - pairingId: 32 random bytes, base64url
 *   - pairingToken: 32 random bytes, base64url (goes in URL fragment, never in server logs)
 *   - cliSecret: 32 random bytes, base64url (never exposed to the phone)
 *   - Rate limited: 20/min per IP (prevents pairing-session spam)
 *   - All stored with 120s TTL in Redis — auto-expire if pairing not completed
 *
 * Per §3.1 and §4.2.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { randomBytes } from "node:crypto";
import type { PairingStore } from "../redis/pairing-store.js";

/** 32 random bytes → base64url string (URL-safe, no padding) */
function generateSecureToken(): string {
  return randomBytes(32).toString("base64url");
}

export interface PairInitResponse {
  pairingId: string;
  pairingToken: string;
  cliSecret: string;
  expiresAt: number;
}

export function registerPairInitRoute(
  server: FastifyInstance,
  pairingStore: PairingStore
): void {
  server.post(
    "/api/pair/init",
    {
      config: {
        rateLimit: {
          max: 20,
          timeWindow: "1 minute",
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      // Generate all cryptographic material
      const pairingId = generateSecureToken();
      const pairingToken = generateSecureToken();
      const cliSecret = generateSecureToken();

      // Expiry: 120 seconds from now
      const expiresAt = Date.now() + 120_000;

      // Store in Redis with 120s TTL
      await pairingStore.create({
        pairingId,
        pairingToken,
        cliSecret,
        expiresAt,
      });

      request.log.info({ pairingId }, "Pairing session created");

      // Return ALL three secrets to the CLI:
      // - pairingId + pairingToken → CLI constructs QR URL: https://host/p/{pairingId}#{pairingToken}
      //   (token in fragment = never sent to server in HTTP, only read client-side by phone)
      // - cliSecret → CLI uses this to authenticate its WebSocket connection
      // - expiresAt → CLI shows countdown, knows when to give up
      const response: PairInitResponse = {
        pairingId,
        pairingToken,
        cliSecret,
        expiresAt,
      };

      return reply.code(201).send(response);
    }
  );
}
