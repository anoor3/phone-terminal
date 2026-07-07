/**
 * WebSocket message router for phone-terminal.
 *
 * Parses incoming WS messages, validates their structure, and routes
 * to the appropriate handler based on message type.
 *
 * Per §3.2, message types:
 *   CLI → BE: cli_hello { pairingId, cliSecret }
 *   Phone → BE: phone_claim { pairingId, pairingToken }
 *   Phone → BE → CLI: code_submit { pairingId, code }
 *   Phone → BE → CLI: input (signed envelope)
 *   Phone → BE → CLI: resize (signed envelope)
 *   Phone → BE → CLI: disconnect (signed envelope)
 *   CLI → BE → Phone: output { sessionId, chunk }
 *   CLI → BE → Phone: status { sessionId, state }
 *   CLI → BE → Phone: disconnect { reason }
 *
 * Security:
 * - All messages must be valid JSON
 * - All messages must have a 'type' field
 * - Unknown message types are rejected
 * - Payloads are size-limited (16KB from Fastify bodyLimit on HTTP,
 *   and we enforce a similar limit here for WS)
 */

import type { WebSocket } from "@fastify/websocket";
import type { PairingStore } from "../db/pairing-store.js";
import { SocketRegistry } from "./handler.js";

const MAX_WS_MESSAGE_SIZE = 16 * 1024; // 16KB — same as HTTP body limit

export interface WsMessage {
  type: string;
  [key: string]: unknown;
}

/**
 * Safely parse a WS message. Returns null if invalid.
 */
function parseMessage(raw: string): WsMessage | null {
  if (raw.length > MAX_WS_MESSAGE_SIZE) return null;

  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    if (!("type" in parsed) || typeof (parsed as Record<string, unknown>)["type"] !== "string") return null;
    return parsed as WsMessage;
  } catch {
    return null;
  }
}

/**
 * Send a JSON message over a WebSocket.
 */
export function wsSend(socket: WebSocket, message: Record<string, unknown>): void {
  if (socket.readyState === 1) { // WebSocket.OPEN
    socket.send(JSON.stringify(message));
  }
}

/**
 * Send an error and optionally close the socket.
 */
export function wsError(socket: WebSocket, error: string, close = false): void {
  wsSend(socket, { type: "error", error });
  if (close) {
    socket.close(1008, error);
  }
}

export interface MessageRouterDeps {
  pairingStore: PairingStore;
  socketRegistry: SocketRegistry;
  onCliHello: (socket: WebSocket, pairingId: string, cliSecret: string, ip: string) => Promise<void>;
  onPhoneClaim: (socket: WebSocket, pairingId: string, pairingToken: string, ip: string) => Promise<void>;
  onCodeSubmit: (socket: WebSocket, pairingId: string, code: string, ip: string) => Promise<void>;
  onControlMessage: (socket: WebSocket, message: WsMessage, ip: string) => Promise<void>;
  onDisconnect: (socket: WebSocket, message: WsMessage, ip: string) => Promise<void>;
}

/**
 * Create the message handler function for incoming WS messages.
 */
export function createMessageRouter(deps: MessageRouterDeps) {
  return async (socket: WebSocket, raw: string, ip: string): Promise<void> => {
    const message = parseMessage(raw);
    if (!message) {
      wsError(socket, "invalid_message");
      return;
    }

    switch (message["type"]) {
      case "cli_hello": {
        const pairingId = message["pairingId"];
        const cliSecret = message["cliSecret"];
        if (typeof pairingId !== "string" || typeof cliSecret !== "string") {
          wsError(socket, "invalid_payload", true);
          return;
        }
        await deps.onCliHello(socket, pairingId, cliSecret, ip);
        break;
      }

      case "phone_claim": {
        const pairingId = message["pairingId"];
        const pairingToken = message["pairingToken"];
        if (typeof pairingId !== "string" || typeof pairingToken !== "string") {
          wsError(socket, "invalid_payload", true);
          return;
        }
        await deps.onPhoneClaim(socket, pairingId, pairingToken, ip);
        break;
      }

      case "code_submit": {
        const pairingId = message["pairingId"];
        const code = message["code"];
        if (typeof pairingId !== "string" || typeof code !== "string") {
          wsError(socket, "invalid_payload");
          return;
        }
        await deps.onCodeSubmit(socket, pairingId, code, ip);
        break;
      }

      case "input":
      case "resize":
      case "output":
      case "status": {
        await deps.onControlMessage(socket, message, ip);
        break;
      }

      case "disconnect": {
        await deps.onDisconnect(socket, message, ip);
        break;
      }

      case "ping": {
        wsSend(socket, { type: "pong" });
        break;
      }

      default: {
        wsError(socket, "unknown_message_type");
        break;
      }
    }
  };
}
