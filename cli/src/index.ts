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
    const { handleCodeSubmission } = await import("./code-submit.js");
    try {
      const session = await executeConnect();
      console.log(`  ✓ WebSocket connected, awaiting phone scan...`);
      console.log(`    Pairing ID: ${session.pairingId.slice(0, 8)}...\n`);

      // Wait for phone to claim the pairing
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error("Pairing timed out — no phone scanned within 120s"));
        }, 120_000);

        session.ws.on("message", (data: Buffer | ArrayBuffer | Buffer[]) => {
          const msg = JSON.parse(data.toString()) as Record<string, unknown>;
          if (msg["type"] === "phone_claimed") {
            clearTimeout(timeout);
            console.log("  📱 Phone connected!\n");
            resolve();
          } else if (msg["type"] === "error") {
            clearTimeout(timeout);
            reject(new Error(msg["error"] as string));
          }
        });

        session.ws.on("close", () => {
          clearTimeout(timeout);
          reject(new Error("Connection closed"));
        });
      });

      // Phone claimed — now handle code submission
      const codeResult = await handleCodeSubmission(session.ws, session.pairingId);
      if (!codeResult.success) {
        console.error(`  Pairing failed: ${codeResult.error}`);
        process.exit(1);
      }

      // Wait for paired event
      console.log("  Waiting for session to be established...\n");
      // Keep process alive
      session.ws.on("close", () => {
        console.log("  Session ended.");
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
