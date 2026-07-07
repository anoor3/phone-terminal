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

const program = new Command();

program
  .name("phone-terminal")
  .description("Cryptographically secured phone-to-laptop remote terminal control")
  .version("0.1.0");

program
  .command("connect")
  .description("Start a new pairing session (generates QR code)")
  .action(async () => {
    // Implemented in task 15
    console.log("connect command — not yet implemented");
  });

program
  .command("disconnect")
  .description("Kill the current phone session")
  .action(async () => {
    // Implemented in task 22
    console.log("disconnect command — not yet implemented");
  });

program
  .command("devices")
  .description("List all devices ever paired to this machine")
  .action(async () => {
    // Implemented in task 22
    console.log("devices command — not yet implemented");
  });

program
  .command("revoke")
  .description("Permanently revoke a specific device")
  .argument("<deviceId>", "Device ID to revoke (from 'devices' command)")
  .action(async (_deviceId: string) => {
    // Implemented in task 22
    console.log("revoke command — not yet implemented");
  });

program
  .command("status")
  .description("Print current connection state")
  .action(async () => {
    // Implemented in task 22
    console.log("status command — not yet implemented");
  });

program
  .command("audit")
  .description("View audit log for a session")
  .requiredOption("--session <id>", "Session ID to view")
  .option("--export <format>", "Export format (json)")
  .action(async (_opts: { session: string; export?: string }) => {
    // Implemented in task 24
    console.log("audit command — not yet implemented");
  });

program.parse();
