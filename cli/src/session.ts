/**
 * CLI session handler — spawned after 'paired' event is received.
 *
 * Per §5.2:
 * - Store publicKeyJwk in memory (CLI's own copy — never trusts backend again)
 * - Spawn node-pty shell process
 * - Set stdin to raw mode
 * - Intercept Ctrl+D (0x04) → disconnect phone (never forward to pty)
 * - Pass through Ctrl+C (0x03) → SIGINT to running program (normal behavior)
 * - All other bytes → forwarded to pty OR come from verified phone input
 *
 * Security:
 * - publicKeyJwk stored IN MEMORY ONLY — never written to disk
 * - pty lifetime is strictly child of this process (§5.5)
 * - stdin interception prevents accidental disconnect via Ctrl+C
 * - Ctrl+D is the ONLY disconnect trigger from the keyboard
 */

import * as pty from "node-pty";
import type WebSocket from "ws";
import { platform } from "node:os";

export interface PairedEventData {
  sessionId: string;
  deviceId: string;
  deviceLabel: string;
  publicKeyJwk: Record<string, unknown>;
}

export interface SessionState {
  sessionId: string;
  deviceId: string;
  deviceLabel: string;
  publicKeyJwk: Record<string, unknown>;
  ptyProcess: pty.IPty;
  ws: WebSocket;
  lastSeq: number;
  consecutiveSigFailures: number;
  connected: boolean;
}

/**
 * Initialize the control session after receiving the 'paired' event.
 *
 * This is the transition from "pairing phase" to "control phase" —
 * from here on, the CLI verifies every incoming message locally.
 */
export function initializeSession(
  ws: WebSocket,
  pairedData: PairedEventData,
  onDisconnect: (reason: string) => void
): SessionState {
  // 1. Store public key IN MEMORY (never disk)
  const { sessionId, deviceId, deviceLabel, publicKeyJwk } = pairedData;

  // 2. Spawn shell via node-pty
  const shell = platform() === "win32" ? "powershell.exe" : process.env["SHELL"] ?? "/bin/bash";
  const ptyProcess = pty.spawn(shell, [], {
    name: "xterm-256color",
    cols: 80,
    rows: 24,
    cwd: process.env["HOME"] ?? process.cwd(),
    env: process.env as Record<string, string>,
  });

  // 3. Create session state
  const state: SessionState = {
    sessionId,
    deviceId,
    deviceLabel,
    publicKeyJwk,
    ptyProcess,
    ws,
    lastSeq: -1, // First valid seq must be > -1 (i.e., >= 0)
    consecutiveSigFailures: 0,
    connected: true,
  };

  // 4. Set up stdin interception per §5.2
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
  }
  process.stdin.resume();
  process.stdin.on("data", (chunk: Buffer) => {
    if (!state.connected) return;

    for (let i = 0; i < chunk.length; i++) {
      const byte = chunk[i]!;

      if (byte === 0x04) {
        // Ctrl+D → disconnect phone, DO NOT forward to pty
        onDisconnect("ctrl_d");
        return; // Swallow the entire chunk after Ctrl+D
      }
    }

    // Everything else (including Ctrl+C = 0x03) passes through to pty
    // This allows normal SIGINT behavior for running programs
    ptyProcess.write(chunk.toString());
  });

  // 5. Handle pty exit (shell closed)
  ptyProcess.onExit(({ exitCode }) => {
    if (state.connected) {
      onDisconnect("terminal_closed");
    }
  });

  return state;
}

/**
 * Clean up the session — kill pty, restore stdin, close WS.
 */
export function teardownSession(state: SessionState, reason: string): void {
  state.connected = false;

  // Restore stdin
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(false);
  }
  process.stdin.pause();

  // Kill pty if still running
  try {
    state.ptyProcess.kill();
  } catch {
    // Already dead — that's fine
  }

  // Send disconnect message to backend (best-effort)
  if (state.ws.readyState === 1) { // WebSocket.OPEN
    try {
      state.ws.send(JSON.stringify({
        type: "disconnect",
        sessionId: state.sessionId,
        reason,
      }));
    } catch {
      // Best effort — socket might already be closing
    }
  }

  // Close WebSocket
  try {
    state.ws.close(1000, reason);
  } catch {
    // Already closed
  }
}
