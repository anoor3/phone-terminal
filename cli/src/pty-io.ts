/**
 * CLI pty I/O — writes verified input to pty, streams output back.
 *
 * Per §3.4:
 * - Phone input arrives as signed envelopes → verified by verify.ts
 * - ONLY after successful verification is input written to pty
 * - pty output (stdout/stderr) streamed back via WS to phone
 *
 * Flow:
 *   Phone → Backend → CLI WS message listener
 *     → parseSignedEnvelope()
 *     → verifyMessage() [session_id, ts, seq, sig]
 *     → if valid: ptyProcess.write(payload)
 *     → if invalid: log warning, check auto-disconnect threshold
 *
 *   ptyProcess.onData(chunk) → ws.send({ type: "output", sessionId, chunk })
 *
 * Security:
 * - NOTHING is written to pty without passing signature verification
 * - Output streaming is unsigned (not a control channel) per §2.5
 * - Resize messages also verified before applying to pty
 */

import type WebSocket from "ws";
import type { SessionState } from "./session.js";
import { parseSignedEnvelope, verifyMessage, shouldAutoDisconnect } from "./verify.js";
import { teardownSession } from "./session.js";

/**
 * Set up the control-phase message handling loop.
 * This is called after pairing completes and the session is active.
 *
 * Handles:
 * - input messages: verified → written to pty
 * - resize messages: verified → applied to pty
 * - disconnect messages: triggers graceful teardown
 */
export function startControlPhase(
  state: SessionState,
  onDisconnect: (reason: string) => void,
  onDangerousCommand?: (input: string) => Promise<boolean>
): void {
  const { ws, ptyProcess, sessionId } = state;

  // --- Incoming messages from phone (via backend relay) ---
  ws.on("message", async (data: WebSocket.RawData) => {
    if (!state.connected) return;

    const raw = data.toString();

    // Try to parse as a non-signed control message first
    try {
      const msg = JSON.parse(raw) as Record<string, unknown>;
      const type = msg["type"] as string;

      // Handle disconnect from server/phone
      if (type === "disconnect") {
        const reason = (msg["reason"] as string) ?? "remote_disconnect";
        onDisconnect(reason);
        return;
      }

      // Handle non-signed messages (pass through without verification)
      if (type === "cli_hello_ack" || type === "phone_claimed" || type === "paired" ||
          type === "code_valid" || type === "code_invalid" || type === "code_locked" ||
          type === "error" || type === "pong") {
        return; // These are handled elsewhere in the pairing flow
      }
    } catch {
      // Not valid JSON — ignore
      return;
    }

    // All other messages should be signed envelopes
    const envelope = parseSignedEnvelope(raw);
    if (!envelope) {
      console.error("  ⚠ Received malformed message (not a valid envelope)");
      return;
    }

    // Verify signature, seq, ts, sessionId
    const result = verifyMessage(state, envelope);

    if (!result.valid) {
      console.error(`  ⚠ Message verification failed: ${result.reason}`);

      if (shouldAutoDisconnect(state)) {
        console.error("\n  🚨 3 CONSECUTIVE SIGNATURE FAILURES — LIKELY TAMPERING");
        console.error("  🚨 Auto-disconnecting for security.\n");
        onDisconnect("sig_fail");
      }
      return;
    }

    // --- Message verified — process by type ---
    switch (result.type) {
      case "input": {
        const input = typeof result.payload === "string"
          ? result.payload
          : String(result.payload);

        // Check for dangerous commands (if handler provided)
        if (onDangerousCommand) {
          const allowed = await onDangerousCommand(input);
          if (!allowed) {
            // Blocked — notify phone
            ws.send(JSON.stringify({
              type: "status",
              sessionId,
              state: "command_blocked",
              detail: "Dangerous command blocked by laptop confirmation",
            }));
            return;
          }
        }

        // Write verified input to pty
        ptyProcess.write(input);
        break;
      }

      case "resize": {
        const payload = result.payload as { cols?: number; rows?: number } | null;
        if (payload && typeof payload.cols === "number" && typeof payload.rows === "number") {
          ptyProcess.resize(payload.cols, payload.rows);
        }
        break;
      }

      case "disconnect": {
        onDisconnect("phone_disconnect");
        break;
      }

      default: {
        console.error(`  ⚠ Unknown verified message type: ${result.type}`);
        break;
      }
    }
  });

  // --- Outgoing: stream pty output to phone via backend ---
  ptyProcess.onData((chunk: string) => {
    if (!state.connected) return;
    if (ws.readyState !== 1) return; // WebSocket.OPEN

    // Output is NOT signed (not a control channel) per §2.5
    // But it IS scoped to this sessionId
    ws.send(JSON.stringify({
      type: "output",
      sessionId,
      chunk,
    }));
  });
}
