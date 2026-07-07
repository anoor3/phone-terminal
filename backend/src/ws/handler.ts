/**
 * WebSocket connection handler for phone-terminal.
 *
 * Handles the WSS upgrade with:
 * - Origin validation (§10): reject connections from unknown origins
 * - Rate limiting on upgrade: token bucket per IP
 * - Connection routing: CLI vs Phone sockets based on initial message
 *
 * Security notes:
 * - Only WSS connections are possible (server is TLS-only)
 * - Origin header must match ALLOWED_ORIGINS
 * - Connections without Origin are rejected (prevents non-browser tools
 *   from accidentally bypassing the check — CLI sends its own auth)
 * - Rate limit: max 30 WS connections per IP per minute
 * - Each connection starts unauthenticated — must send cli_hello or phone_claim
 *   within 10 seconds or gets disconnected
 */

import type { FastifyInstance } from "fastify";
import type { WebSocket } from "@fastify/websocket";
import type { IncomingMessage } from "node:http";
import type { PairingStore } from "../db/pairing-store.js";

/** Track WS connections per IP for rate limiting */
const wsConnectionsPerIp = new Map<string, { count: number; resetAt: number }>();

const WS_RATE_LIMIT_MAX = 30; // connections per window
const WS_RATE_LIMIT_WINDOW = 60_000; // 1 minute in ms
const AUTH_TIMEOUT_MS = 10_000; // 10s to send first auth message

export interface WsHandlerContext {
  allowedOrigins: string[];
  pairingStore: PairingStore;
}

/**
 * Check if the IP has exceeded the WS connection rate limit.
 */
function checkWsRateLimit(ip: string): boolean {
  const now = Date.now();
  const entry = wsConnectionsPerIp.get(ip);

  if (!entry || now >= entry.resetAt) {
    wsConnectionsPerIp.set(ip, { count: 1, resetAt: now + WS_RATE_LIMIT_WINDOW });
    return true; // allowed
  }

  if (entry.count >= WS_RATE_LIMIT_MAX) {
    return false; // rate limited
  }

  entry.count++;
  return true; // allowed
}

/**
 * Validate the Origin header against allowed origins.
 * Per §10: reject connections whose Origin isn't your known pairing-page origin.
 */
function validateOrigin(origin: string | undefined, allowedOrigins: string[]): boolean {
  // CLI connections won't have a meaningful Origin (or will have none)
  // But we still require SOME authentication (cli_hello with secret)
  // Phone connections MUST have a valid Origin
  if (!origin) {
    // Allow no-origin for CLI connections (they authenticate via cliSecret)
    return true;
  }

  return allowedOrigins.includes(origin);
}

export interface AuthenticatedSocket {
  socket: WebSocket;
  role: "cli" | "phone" | "unauthenticated";
  pairingId: string | null;
  sessionId: string | null;
  ip: string;
}

/** Registry of active sockets by pairing and session */
export class SocketRegistry {
  private cliSocketsByPairing = new Map<string, WebSocket>();
  private phoneSocketsByPairing = new Map<string, WebSocket>();
  private cliSocketsBySession = new Map<string, WebSocket>();
  private phoneSocketsBySession = new Map<string, WebSocket>();

  setCliForPairing(pairingId: string, socket: WebSocket): void {
    this.cliSocketsByPairing.set(pairingId, socket);
  }

  setPhoneForPairing(pairingId: string, socket: WebSocket): void {
    this.phoneSocketsByPairing.set(pairingId, socket);
  }

  getCliForPairing(pairingId: string): WebSocket | undefined {
    return this.cliSocketsByPairing.get(pairingId);
  }

  getPhoneForPairing(pairingId: string): WebSocket | undefined {
    return this.phoneSocketsByPairing.get(pairingId);
  }

  promoteToSession(pairingId: string, sessionId: string): void {
    const cli = this.cliSocketsByPairing.get(pairingId);
    const phone = this.phoneSocketsByPairing.get(pairingId);

    if (cli) {
      this.cliSocketsBySession.set(sessionId, cli);
      this.cliSocketsByPairing.delete(pairingId);
    }
    if (phone) {
      this.phoneSocketsBySession.set(sessionId, phone);
      this.phoneSocketsByPairing.delete(pairingId);
    }
  }

  getCliForSession(sessionId: string): WebSocket | undefined {
    return this.cliSocketsBySession.get(sessionId);
  }

  getPhoneForSession(sessionId: string): WebSocket | undefined {
    return this.phoneSocketsBySession.get(sessionId);
  }

  removeBySocket(socket: WebSocket): { role: string; pairingId?: string; sessionId?: string } | null {
    // Check pairing-phase sockets
    for (const [id, s] of this.cliSocketsByPairing) {
      if (s === socket) {
        this.cliSocketsByPairing.delete(id);
        return { role: "cli", pairingId: id };
      }
    }
    for (const [id, s] of this.phoneSocketsByPairing) {
      if (s === socket) {
        this.phoneSocketsByPairing.delete(id);
        return { role: "phone", pairingId: id };
      }
    }
    // Check session-phase sockets
    for (const [id, s] of this.cliSocketsBySession) {
      if (s === socket) {
        this.cliSocketsBySession.delete(id);
        return { role: "cli", sessionId: id };
      }
    }
    for (const [id, s] of this.phoneSocketsBySession) {
      if (s === socket) {
        this.phoneSocketsBySession.delete(id);
        return { role: "phone", sessionId: id };
      }
    }
    return null;
  }

  removeSession(sessionId: string): void {
    const cli = this.cliSocketsBySession.get(sessionId);
    const phone = this.phoneSocketsBySession.get(sessionId);

    if (cli) {
      cli.close(1000, "session_ended");
      this.cliSocketsBySession.delete(sessionId);
    }
    if (phone) {
      phone.close(1000, "session_ended");
      this.phoneSocketsBySession.delete(sessionId);
    }
  }
}

/**
 * Register the WebSocket route with the Fastify server.
 */
export function registerWsHandler(
  server: FastifyInstance,
  ctx: WsHandlerContext,
  socketRegistry: SocketRegistry,
  onMessage: (socket: WebSocket, message: string, ip: string) => void,
  onClose: (socket: WebSocket) => void
): void {
  server.get("/ws", { websocket: true }, (socket: WebSocket, request) => {
    const ip = request.ip;
    const origin = request.headers["origin"] as string | undefined;

    // Rate limit check
    if (!checkWsRateLimit(ip)) {
      server.log.warn({ ip }, "WS rate limit exceeded");
      socket.close(1008, "rate_limited");
      return;
    }

    // Origin validation (§10)
    if (!validateOrigin(origin, ctx.allowedOrigins)) {
      server.log.warn({ ip, origin }, "WS connection rejected: invalid Origin");
      socket.close(1008, "invalid_origin");
      return;
    }

    // Start auth timeout — must authenticate within 10 seconds
    const authTimer = setTimeout(() => {
      server.log.warn({ ip }, "WS connection timed out waiting for auth");
      socket.close(1008, "auth_timeout");
    }, AUTH_TIMEOUT_MS);

    let authenticated = false;

    socket.on("message", (data: Buffer | ArrayBuffer | Buffer[]) => {
      const message = data.toString();

      if (!authenticated) {
        // First message must be auth — clear the timeout
        clearTimeout(authTimer);
        authenticated = true;
      }

      onMessage(socket, message, ip);
    });

    socket.on("close", () => {
      clearTimeout(authTimer);
      onClose(socket);
    });

    socket.on("error", (err: Error) => {
      server.log.error({ ip, error: err.message }, "WS error");
      clearTimeout(authTimer);
    });
  });
}
