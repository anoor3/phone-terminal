/**
 * Initial schema for phone-terminal.
 *
 * Tables:
 *   devices    — paired devices with their public keys
 *   sessions   — control sessions (one device, one CLI process)
 *   audit_log  — tamper-evident hash-chained event log
 *
 * Security notes:
 *   - device_id and session_id are 32 random bytes (not sequential/guessable)
 *   - public_key_jwk stored as JSONB (the JWK of the ECDSA P-256 public key)
 *   - audit_log uses hash chaining for tamper evidence (§8)
 *   - revoked_at marks permanently revoked devices
 *   - No PII stored beyond user-provided device labels
 */

import type { MigrationBuilder } from "node-pg-migrate";

export async function up(pgm: MigrationBuilder): Promise<void> {
  // Enable pgcrypto for gen_random_bytes if needed later
  pgm.sql(`CREATE EXTENSION IF NOT EXISTS pgcrypto`);

  // Devices table — one row per paired device (phone)
  pgm.createTable("devices", {
    device_id: {
      type: "bytea",
      primaryKey: true,
      notNull: true,
    },
    public_key_jwk: {
      type: "jsonb",
      notNull: true,
    },
    label: {
      type: "text",
      notNull: true,
    },
    cli_instance: {
      type: "text",
      notNull: true,
      comment: "Opaque identifier for the CLI process that initiated pairing",
    },
    created_at: {
      type: "timestamptz",
      notNull: true,
      default: pgm.func("now()"),
    },
    revoked_at: {
      type: "timestamptz",
      notNull: false,
      comment: "Set when device is permanently revoked — can never re-pair",
    },
  });

  // Index for listing devices by CLI instance
  pgm.createIndex("devices", "cli_instance");
  // Index for finding non-revoked devices
  pgm.createIndex("devices", "revoked_at", {
    name: "idx_devices_active",
    where: "revoked_at IS NULL",
  });

  // Sessions table — one row per control session
  pgm.createTable("sessions", {
    session_id: {
      type: "bytea",
      primaryKey: true,
      notNull: true,
    },
    device_id: {
      type: "bytea",
      notNull: true,
      references: "devices(device_id)",
    },
    cli_instance: {
      type: "text",
      notNull: true,
      comment: "Which CLI process owns this session",
    },
    paired_at: {
      type: "timestamptz",
      notNull: true,
      default: pgm.func("now()"),
    },
    ended_at: {
      type: "timestamptz",
      notNull: false,
    },
    end_reason: {
      type: "text",
      notNull: false,
      comment: "ctrl_d | terminal_closed | revoked | timeout | phone_disconnect | sig_fail",
    },
  });

  // Index for finding active sessions (not yet ended)
  pgm.createIndex("sessions", "ended_at", {
    name: "idx_sessions_active",
    where: "ended_at IS NULL",
  });
  // Index for finding sessions by device
  pgm.createIndex("sessions", "device_id");

  // Audit log — hash-chained for tamper evidence (§8)
  pgm.createTable("audit_log", {
    id: {
      type: "bigserial",
      primaryKey: true,
    },
    session_id: {
      type: "bytea",
      notNull: true,
      comment: "Which session this event belongs to",
    },
    ts: {
      type: "timestamptz",
      notNull: true,
      default: pgm.func("now()"),
    },
    event_type: {
      type: "text",
      notNull: true,
      comment: "paired | input | disconnect | sig_fail | dangerous_confirm | dangerous_block",
    },
    detail: {
      type: "jsonb",
      notNull: true,
      comment: "Event-specific data. Input payloads truncated beyond configurable limit.",
    },
    prev_hash: {
      type: "text",
      notNull: false,
      comment: "Hash of the previous row — null for first row in a session",
    },
    row_hash: {
      type: "text",
      notNull: true,
      comment: "sha256(prev_hash + event_type + detail + ts) for tamper evidence",
    },
  });

  // Index for querying audit log by session
  pgm.createIndex("audit_log", "session_id");
  // Index for time-range queries
  pgm.createIndex("audit_log", "ts");
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable("audit_log");
  pgm.dropTable("sessions");
  pgm.dropTable("devices");
  pgm.sql(`DROP EXTENSION IF EXISTS pgcrypto`);
}
