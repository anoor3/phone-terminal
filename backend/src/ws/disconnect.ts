/**
 * Session disconnect handling.
 *
 * Per §5.5 and §9:
 * - Graceful disconnect: either side sends { type: "disconnect" }
 * - Socket-close detection: backend detects WS close event
 * - CLI process killed: backend detects socket close without graceful message
 *
 * Triggers (§9 table):
 * - Ctrl+D on laptop → CLI sends disconnect (reason: 'ctrl_d')
 * - Phone taps "Disconnect" → phone sends signed disconnect
 * - Terminal closed / CLI exits → socket close detected
 * - Revoke command → handled by revocation endpoint (task 13)
 * - 3 sig failures → handled by relay (task 11)
 *
 * Guarantee: "there is no code path where a control session outlives
 * its owning CLI process" — the pty's lifetime is a direct child of
 * the CLI process lifetime.
 *
 * Security:
 * - Session marked ended_at in Postgres immediately
 * - Both sockets closed
 * - Key cache cleared
 * - Audit log entry written
 * - No dangling "connected" state possible
 */

import type { WebSocket } from "@fastify/websocket";
import type pg from "pg";
import { createHash } from "node:crypto";
import { SocketRegistry } from "./handler.js";
import { wsSend, type WsMessage } from "./router.js";
import { clearSessionKeyCache } from "./relay.js";

export interface DisconnectDeps {
  socketRegistry: SocketRegistry;
  pool: pg.Pool;
  log: (level: "info" | "warn" | "error", data: Record<string, unknown>, msg: string) => void;
}

type EndReason = "ctrl_d" | "terminal_closed" | "phone_disconnect" | "revoked" | "timeout" | "sig_fail";

/**
 * End a session — mark in DB, close sockets, log audit event.
 * This is the single point of truth for ending any session.
 */
export async function endSession(
  deps: DisconnectDeps,
  sessionId: string,
  reason: EndReason,
  initiator: "cli" | "phone" | "server"
): Promise<void> {
  const sessionIdBuf = Buffer.from(sessionId, "base64url");

  // 1. Mark session as ended in Postgres
  const result = await deps.pool.query(
    `UPDATE sessions SET ended_at = NOW(), end_reason = $1
     WHERE session_id = $2 AND ended_at IS NULL
     RETURNING session_id`,
    [reason, sessionIdBuf]
  );

  if (result.rowCount === 0) {
    // Session already ended (race condition with multiple close events)
    deps.log("info", { sessionId, reason }, "disconnect: session already ended");
    return;
  }

  // 2. Write audit log entry
  try {
    // Get the last row_hash for this session to continue the chain
    const lastRow = await deps.pool.query(
      `SELECT row_hash FROM audit_log WHERE session_id = $1 ORDER BY id DESC LIMIT 1`,
      [sessionIdBuf]
    );

    const prevHash = lastRow.rows[0]?.row_hash ?? null;
    const detail = JSON.stringify({ reason, initiator });
    const rowHash = createHash("sha256")
      .update(`${prevHash}|disconnect|${detail}|${new Date().toISOString()}`)
      .digest("hex");

    await deps.pool.query(
      `INSERT INTO audit_log (session_id, event_type, detail, prev_hash, row_hash)
       VALUES ($1, 'disconnect', $2, $3, $4)`,
      [sessionIdBuf, detail, prevHash, rowHash]
    );
  } catch (err) {
    // Audit write failure should not prevent disconnect
    deps.log("error", { sessionId, error: (err as Error).message }, "disconnect: audit log write failed");
  }

  // 3. Clear cached public key for this session
  clearSessionKeyCache(sessionId);

  // 4. Notify the other side (if their socket is still open)
  const cliSocket = deps.socketRegistry.getCliForSession(sessionId);
  const phoneSocket = deps.socketRegistry.getPhoneForSession(sessionId);

  if (initiator !== "cli" && cliSocket && cliSocket.readyState === 1) {
    wsSend(cliSocket, {
      type: "disconnect",
      sessionId,
      reason,
      initiator,
    });
  }

  if (initiator !== "phone" && phoneSocket && phoneSocket.readyState === 1) {
    wsSend(phoneSocket, {
      type: "disconnect",
      sessionId,
      reason,
      initiator,
    });
  }

  // 5. Remove sockets from registry and close them
  deps.socketRegistry.removeSession(sessionId);

  deps.log("info", { sessionId, reason, initiator }, "disconnect: session ended");
}

/**
 * Handle a graceful disconnect message from either side.
 */
export async function handleDisconnectMessage(
  deps: DisconnectDeps,
  socket: WebSocket,
  message: WsMessage,
  _ip: string
): Promise<void> {
  const sessionId = message["sessionId"] as string | undefined;
  const reason = (message["reason"] as string | undefined) ?? "manual";

  if (!sessionId) return;

  // Determine who sent it
  const cliSocket = deps.socketRegistry.getCliForSession(sessionId);
  const phoneSocket = deps.socketRegistry.getPhoneForSession(sessionId);

  let initiator: "cli" | "phone";
  if (socket === cliSocket) {
    initiator = "cli";
  } else if (socket === phoneSocket) {
    initiator = "phone";
  } else {
    return; // Unknown socket — ignore
  }

  const endReason: EndReason = initiator === "cli"
    ? (reason === "ctrl_d" ? "ctrl_d" : "terminal_closed")
    : "phone_disconnect";

  await endSession(deps, sessionId, endReason, initiator);
}

/**
 * Handle a socket close event (ungraceful — no disconnect message received).
 * Per §5.5: "Backend also independently expires any session whose CLI
 * socket disconnects without a graceful message."
 */
export async function handleSocketClose(
  deps: DisconnectDeps,
  socket: WebSocket
): Promise<void> {
  // Find which session this socket belonged to
  const info = deps.socketRegistry.removeBySocket(socket);
  if (!info || !info.sessionId) return;

  // Determine reason based on role
  const reason: EndReason = info.role === "cli" ? "terminal_closed" : "phone_disconnect";
  const initiator = info.role as "cli" | "phone";

  await endSession(deps, info.sessionId, reason, initiator);
}
