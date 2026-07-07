#!/usr/bin/env node
/**
 * phone-terminal CLI — entry point.
 *
 * Commands per §5.4:
 *   connect      — start a new pairing + session
 *   disconnect   — kill the current phone session
 *   devices      — list all paired devices
 *   revoke <id>  — revoke a specific device permanently
 *   status       — print current connection state
 *   audit        — view audit log for a session
 */

import { Command } from "commander";
import type { SessionState } from "./session.js";

/**
 * Module-level active session state.
 * Set by the connect flow when pairing completes.
 * Read by disconnect/status commands.
 */
let activeSession: SessionState | null = null;

export function setActiveSession(session: SessionState | null): void {
  activeSession = session;
}

export function getActiveSession(): SessionState | null {
  return activeSession;
}

const program = new Command();

program
  .name("phone-terminal")
  .description("Cryptographically secured phone-to-laptop remote terminal control")
  .version("0.1.0");

program
  .command("connect")
  .description("Start a new pairing session (generates QR code)")
  .action(async () => {
    const { executeConnect } = await import("./connect.js");
    try {
      const session = await executeConnect();
      console.log(`  ✓ WebSocket connected, awaiting phone scan...`);
      console.log(`    Pairing ID: ${session.pairingId.slice(0, 8)}...\n`);

      const ws = session.ws;

      // Single unified message handler for the entire pairing flow
      const pairingResult = await new Promise<{ sessionId: string; deviceId: string; deviceLabel: string; publicKeyJwk: Record<string, unknown> }>(async (resolve, reject) => {
        let phase: "waiting_phone" | "entering_code" | "waiting_paired" = "waiting_phone";
        const timeout = setTimeout(() => reject(new Error("Pairing timed out (120s)")), 120_000);

        const { createInterface } = await import("node:readline");
        let rl: ReturnType<typeof createInterface> | null = null;

        ws.on("message", (data: Buffer | ArrayBuffer | Buffer[]) => {
          const msg = JSON.parse(data.toString()) as Record<string, unknown>;
          const type = msg["type"] as string;

          if (type === "phone_claimed" && phase === "waiting_phone") {
            phase = "entering_code";
            console.log("  📱 Phone connected! A verification code is on your phone.\n");

            // Prompt for code
            rl = createInterface({ input: process.stdin, output: process.stdout });
            const askCode = (): void => {
              rl!.question("  Enter the 6-digit code: ", (answer: string) => {
                const code = answer.trim();
                if (!/^\d{6}$/.test(code)) {
                  console.log("  ⚠ Must be exactly 6 digits.\n");
                  askCode();
                  return;
                }
                ws.send(JSON.stringify({ type: "code_submit", pairingId: session.pairingId, code }));
                phase = "waiting_paired";
              });
            };
            askCode();
          } else if (type === "code_invalid" && phase === "waiting_paired") {
            const remaining = msg["remaining"] as number;
            console.log(`  ✗ Invalid code. ${remaining} attempts left.\n`);
            phase = "entering_code";
            const askCode = (): void => {
              rl!.question("  Enter the 6-digit code: ", (answer: string) => {
                const code = answer.trim();
                if (!/^\d{6}$/.test(code)) {
                  console.log("  ⚠ Must be exactly 6 digits.\n");
                  askCode();
                  return;
                }
                ws.send(JSON.stringify({ type: "code_submit", pairingId: session.pairingId, code }));
                phase = "waiting_paired";
              });
            };
            askCode();
          } else if (type === "code_locked") {
            clearTimeout(timeout);
            if (rl) rl.close();
            reject(new Error("Max attempts exceeded. Run 'connect' again."));
          } else if (type === "paired") {
            clearTimeout(timeout);
            if (rl) rl.close();
            resolve({
              sessionId: msg["sessionId"] as string,
              deviceId: msg["deviceId"] as string,
              deviceLabel: msg["deviceLabel"] as string,
              publicKeyJwk: msg["publicKeyJwk"] as Record<string, unknown>,
            });
          } else if (type === "error") {
            clearTimeout(timeout);
            if (rl) rl.close();
            reject(new Error(msg["error"] as string ?? "Unknown error"));
          }
        });

        ws.on("close", () => {
          clearTimeout(timeout);
          if (rl) rl.close();
          reject(new Error("Connection closed"));
        });
      });

      // Pairing complete! Start the control phase.
      const { initializeSession, teardownSession } = await import("./session.js");
      const { startControlPhase } = await import("./pty-io.js");
      const { renderConnectedBox, renderDisconnectedBox } = await import("./status-box.js");

      console.log("");
      renderConnectedBox({ deviceLabel: pairingResult.deviceLabel, sessionId: pairingResult.sessionId });

      // Initialize session: spawn pty, set up stdin interception
      const state = initializeSession(ws, {
        sessionId: pairingResult.sessionId,
        deviceId: pairingResult.deviceId,
        deviceLabel: pairingResult.deviceLabel,
        publicKeyJwk: pairingResult.publicKeyJwk,
      }, (reason: string) => {
        // On disconnect callback
        renderDisconnectedBox({ reason });
        teardownSession(state, reason);
        process.exit(0);
      });

      // Start control phase: verified input → pty, pty output → phone
      startControlPhase(state, (reason: string) => {
        renderDisconnectedBox({ reason });
        teardownSession(state, reason);
        process.exit(0);
      });

    } catch (err) {
      console.error(`  ✗ ${(err as Error).message}`);
      process.exit(1);
    }
  });

program
  .command("disconnect")
  .description("Kill the current phone session")
  .action(async () => {
    if (!activeSession || !activeSession.connected) {
      console.log("no active session");
      return;
    }

    // Send disconnect over WS
    if (activeSession.ws.readyState === 1) {
      try {
        activeSession.ws.send(
          JSON.stringify({
            type: "disconnect",
            sessionId: activeSession.sessionId,
            reason: "user_disconnect",
          })
        );
      } catch {
        // Best effort
      }
    }

    activeSession.connected = false;
    console.log("  ✓ Disconnected from session:", activeSession.sessionId.slice(0, 8) + "...");
  });

program
  .command("devices")
  .description("List all devices ever paired to this machine")
  .action(async () => {
    const { getCliInstance } = await import("./connect.js");

    const apiBaseUrl = process.env["PHONE_TERMINAL_API_URL"] ?? "";
    if (!apiBaseUrl) {
      console.error("ERROR: PHONE_TERMINAL_API_URL not set");
      process.exit(1);
    }
    if (!apiBaseUrl.startsWith("https://")) {
      console.error("ERROR: PHONE_TERMINAL_API_URL must use https://");
      process.exit(1);
    }

    const url = `${apiBaseUrl}/api/devices?cliInstance=${encodeURIComponent(getCliInstance())}`;

    try {
      const response = await fetch(url);
      if (!response.ok) {
        const text = await response.text();
        console.error(`  ✗ Failed to fetch devices (${response.status}): ${text}`);
        process.exit(1);
      }

      const data = (await response.json()) as {
        devices: Array<{
          deviceId: string;
          deviceLabel: string;
          pairedAt: string;
          revoked: boolean;
        }>;
      };

      if (data.devices.length === 0) {
        console.log("  No paired devices.");
        return;
      }

      // Print table header
      console.log("");
      console.log(
        "  " +
          "Device ID".padEnd(20) +
          "Label".padEnd(24) +
          "Paired At".padEnd(26) +
          "Status"
      );
      console.log("  " + "─".repeat(76));

      // Print rows
      for (const device of data.devices) {
        const id = device.deviceId.slice(0, 16) + "...";
        const label = device.deviceLabel.slice(0, 22).padEnd(24);
        const paired = new Date(device.pairedAt).toLocaleString().padEnd(26);
        const status = device.revoked ? "REVOKED" : "active";

        console.log(`  ${id.padEnd(20)}${label}${paired}${status}`);
      }
      console.log("");
    } catch (err) {
      console.error(`  ✗ Network error: ${(err as Error).message}`);
      process.exit(1);
    }
  });

program
  .command("revoke")
  .description("Permanently revoke a specific device")
  .argument("<deviceId>", "Device ID to revoke (from 'devices' command)")
  .action(async (deviceId: string) => {
    const { getCliInstance } = await import("./connect.js");

    const apiBaseUrl = process.env["PHONE_TERMINAL_API_URL"] ?? "";
    if (!apiBaseUrl) {
      console.error("ERROR: PHONE_TERMINAL_API_URL not set");
      process.exit(1);
    }
    if (!apiBaseUrl.startsWith("https://")) {
      console.error("ERROR: PHONE_TERMINAL_API_URL must use https://");
      process.exit(1);
    }

    const url = `${apiBaseUrl}/api/devices/revoke`;

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          deviceId,
          cliInstance: getCliInstance(),
        }),
      });

      if (!response.ok) {
        const text = await response.text();
        console.error(`  ✗ Revoke failed (${response.status}): ${text}`);
        process.exit(1);
      }

      const result = (await response.json()) as { success: boolean; message?: string };
      if (result.success) {
        console.log(`  ✓ Device ${deviceId.slice(0, 8)}... revoked permanently.`);
      } else {
        console.log(`  ✗ Revoke failed: ${result.message ?? "unknown error"}`);
      }
    } catch (err) {
      console.error(`  ✗ Network error: ${(err as Error).message}`);
      process.exit(1);
    }
  });

program
  .command("status")
  .description("Print current connection state")
  .action(async () => {
    if (!activeSession || !activeSession.connected) {
      console.log("no active session");
      return;
    }

    console.log(`  Session:  ${activeSession.sessionId.slice(0, 8)}...`);
    console.log(`  Device:   ${activeSession.deviceLabel} (${activeSession.deviceId.slice(0, 8)}...)`);
    console.log(`  Status:   connected`);
    console.log(`  Last seq: ${activeSession.lastSeq}`);
  });

program
  .command("audit")
  .description("View audit log for a session")
  .requiredOption("--session <id>", "Session ID to view")
  .option("--export <format>", "Export format (json)")
  .action(async (opts: { session: string; export?: string }) => {
    const { executeAudit } = await import("./audit.js");
    await executeAudit(opts.session, opts.export);
  });

program.parse();
