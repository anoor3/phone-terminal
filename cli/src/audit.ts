/**
 * CLI 'audit' command — fetch and verify session audit log.
 *
 * Calls GET /api/audit?sessionId=<id>&cliInstance=<cliInstance>
 * Verifies hash chain integrity locally (zero-trust).
 *
 * Hash chain model:
 * - Each row has: id, ts, event_type, detail, prev_hash, row_hash
 * - row_hash = sha256(prev_hash + event_type + detail + ts)
 * - If any link is broken, print WARNING
 *
 * Output:
 * - Default: human-readable timeline (timestamp | event_type | detail)
 * - --export json: raw JSON dump
 */

import { createHash } from "node:crypto";
import { getCliInstance } from "./connect.js";

export interface AuditEvent {
  id: string;
  ts: string;
  event_type: string;
  detail: string;
  prev_hash: string;
  row_hash: string;
}

interface AuditResponse {
  events: AuditEvent[];
}

/**
 * Compute expected row_hash from components.
 * Formula: sha256(prev_hash + event_type + detail + ts)
 */
function computeRowHash(
  prevHash: string,
  eventType: string,
  detail: string,
  ts: string
): string {
  const input = prevHash + eventType + detail + ts;
  return createHash("sha256").update(input).digest("hex");
}

/**
 * Verify the hash chain integrity of audit events.
 * Returns an array of indices where the chain is broken.
 */
export function verifyHashChain(events: AuditEvent[]): number[] {
  const broken: number[] = [];

  for (let i = 0; i < events.length; i++) {
    const event = events[i]!;
    const expectedHash = computeRowHash(
      event.prev_hash,
      event.event_type,
      event.detail,
      event.ts
    );

    if (expectedHash !== event.row_hash) {
      broken.push(i);
    }

    // Also verify chain linkage: event[i].prev_hash should match event[i-1].row_hash
    if (i > 0) {
      const prevEvent = events[i - 1]!;
      if (event.prev_hash !== prevEvent.row_hash) {
        if (!broken.includes(i)) {
          broken.push(i);
        }
      }
    }
  }

  return broken;
}

/**
 * Execute the audit command.
 * Fetches audit log from backend, verifies hash chain, and prints output.
 */
export async function executeAudit(
  sessionId: string,
  exportFormat?: string
): Promise<void> {
  const apiBaseUrl = process.env["PHONE_TERMINAL_API_URL"] ?? "";
  if (!apiBaseUrl) {
    console.error("ERROR: PHONE_TERMINAL_API_URL not set");
    process.exit(1);
  }
  if (!apiBaseUrl.startsWith("https://")) {
    console.error("ERROR: PHONE_TERMINAL_API_URL must use https://");
    process.exit(1);
  }

  const cliInstance = getCliInstance();
  const url = `${apiBaseUrl}/api/audit?sessionId=${encodeURIComponent(sessionId)}&cliInstance=${encodeURIComponent(cliInstance)}`;

  let data: AuditResponse;
  try {
    const response = await fetch(url);
    if (!response.ok) {
      const text = await response.text();
      console.error(`  ✗ Failed to fetch audit log (${response.status}): ${text}`);
      process.exit(1);
    }
    data = (await response.json()) as AuditResponse;
  } catch (err) {
    console.error(`  ✗ Network error: ${(err as Error).message}`);
    process.exit(1);
  }

  // --export json: dump raw JSON and exit
  if (exportFormat === "json") {
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  // Verify hash chain integrity
  const brokenLinks = verifyHashChain(data.events);

  if (brokenLinks.length > 0) {
    console.log("");
    console.log("  ⚠  WARNING: Hash chain integrity broken at the following entries:");
    for (const idx of brokenLinks) {
      const event = data.events[idx]!;
      console.log(`      Row ${idx}: ${event.event_type} at ${event.ts}`);
    }
    console.log("  ⚠  The audit log may have been tampered with!\n");
  }

  // Print human-readable timeline
  if (data.events.length === 0) {
    console.log("  No audit events for this session.");
    return;
  }

  console.log("");
  console.log(`  Audit log for session: ${sessionId.slice(0, 8)}...`);
  console.log(`  ${data.events.length} event(s)\n`);
  console.log(
    "  " +
      "Timestamp".padEnd(26) +
      "Event".padEnd(24) +
      "Detail"
  );
  console.log("  " + "─".repeat(76));

  for (let i = 0; i < data.events.length; i++) {
    const event = data.events[i]!;
    const ts = new Date(event.ts).toLocaleString().padEnd(26);
    const type = event.event_type.padEnd(24);
    const isBroken = brokenLinks.includes(i);
    const marker = isBroken ? " ⚠" : "";

    console.log(`  ${ts}${type}${event.detail}${marker}`);
  }

  console.log("");

  if (brokenLinks.length === 0) {
    console.log("  ✓ Hash chain verified — all entries intact.");
  }
  console.log("");
}
