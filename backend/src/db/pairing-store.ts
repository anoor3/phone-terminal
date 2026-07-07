/**
 * Postgres-based pairing store (replaces Redis).
 *
 * Uses the pairing_state table in Supabase Postgres.
 * TTL is enforced via expires_at column + cleanup trigger.
 * All security properties are preserved:
 * - 120s expiry
 * - Constant-time token/code comparison
 * - Single-use claim (atomic state transition)
 * - Max 5 code attempts
 */

import { timingSafeEqual } from "node:crypto";
import type pg from "pg";

const PAIRING_TTL_MS = 120_000; // 120 seconds

export type PairingState = "pending" | "claimed";

export interface PairingData {
  pairingId: string;
  pairingToken: string;
  cliSecret: string;
  expiresAt: number;
}

export class PairingStore {
  constructor(private readonly pool: pg.Pool) {}

  /**
   * Create a new pairing session.
   */
  async create(data: PairingData): Promise<void> {
    const expiresAt = new Date(data.expiresAt).toISOString();
    await this.pool.query(
      `INSERT INTO pairing_state (pairing_id, pairing_token, cli_secret, state, expires_at)
       VALUES ($1, $2, $3, 'pending', $4)`,
      [data.pairingId, data.pairingToken, data.cliSecret, expiresAt]
    );
  }

  /**
   * Get the current state of a pairing session.
   * Returns null if expired or never existed.
   */
  async getState(pairingId: string): Promise<PairingState | null> {
    const result = await this.pool.query(
      `SELECT state FROM pairing_state WHERE pairing_id = $1 AND expires_at > now()`,
      [pairingId]
    );
    if (result.rows.length === 0) return null;
    const state = result.rows[0]!.state as string;
    if (state === "pending" || state === "claimed") return state;
    return null;
  }

  /**
   * Validate the CLI secret for a pairing session.
   * Uses constant-time comparison to prevent timing attacks.
   */
  async validateCliSecret(pairingId: string, secret: string): Promise<boolean> {
    const result = await this.pool.query(
      `SELECT cli_secret FROM pairing_state WHERE pairing_id = $1 AND expires_at > now()`,
      [pairingId]
    );
    if (result.rows.length === 0) return false;

    const stored = result.rows[0]!.cli_secret as string;
    const storedBuf = Buffer.from(stored, "utf-8");
    const providedBuf = Buffer.from(secret, "utf-8");

    if (storedBuf.length !== providedBuf.length) return false;
    return timingSafeEqual(storedBuf, providedBuf);
  }

  /**
   * Validate pairing token and claim the session (single-use).
   * Atomic: only the first claimer wins.
   */
  async claim(pairingId: string, token: string): Promise<boolean> {
    // Get current state + token
    const result = await this.pool.query(
      `SELECT pairing_token, state FROM pairing_state
       WHERE pairing_id = $1 AND expires_at > now()`,
      [pairingId]
    );
    if (result.rows.length === 0) return false;

    const row = result.rows[0]!;
    if (row.state !== "pending") return false;

    // Constant-time token comparison
    const storedBuf = Buffer.from(row.pairing_token as string, "utf-8");
    const providedBuf = Buffer.from(token, "utf-8");
    if (storedBuf.length !== providedBuf.length) return false;
    if (!timingSafeEqual(storedBuf, providedBuf)) return false;

    // Atomic state transition — only succeeds if still pending
    const update = await this.pool.query(
      `UPDATE pairing_state SET state = 'claimed'
       WHERE pairing_id = $1 AND state = 'pending'
       RETURNING pairing_id`,
      [pairingId]
    );

    return (update.rowCount ?? 0) > 0;
  }

  /**
   * Store the verification code for a pairing session.
   */
  async setCode(pairingId: string, code: string): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE pairing_state SET verification_code = $1, attempts = 0
       WHERE pairing_id = $2 AND state = 'claimed' AND expires_at > now()
       RETURNING pairing_id`,
      [code, pairingId]
    );
    return (result.rowCount ?? 0) > 0;
  }

  /**
   * Validate a code submission.
   * Returns: "valid" | "invalid" | "locked" | "expired"
   */
  async validateCode(
    pairingId: string,
    submittedCode: string
  ): Promise<"valid" | "invalid" | "locked" | "expired"> {
    const result = await this.pool.query(
      `SELECT verification_code, attempts FROM pairing_state
       WHERE pairing_id = $1 AND expires_at > now()`,
      [pairingId]
    );
    if (result.rows.length === 0) return "expired";

    const row = result.rows[0]!;
    const storedCode = row.verification_code as string | null;
    if (!storedCode) return "expired";

    const attempts = row.attempts as number;
    if (attempts >= 5) return "locked";

    // Increment attempts BEFORE comparison (race-safe)
    await this.pool.query(
      `UPDATE pairing_state SET attempts = attempts + 1 WHERE pairing_id = $1`,
      [pairingId]
    );

    // Constant-time comparison
    const storedBuf = Buffer.from(storedCode, "utf-8");
    const providedBuf = Buffer.from(submittedCode, "utf-8");
    if (storedBuf.length !== providedBuf.length) return "invalid";
    if (!timingSafeEqual(storedBuf, providedBuf)) return "invalid";

    return "valid";
  }

  /**
   * Get remaining attempts for a pairing session.
   */
  async getRemainingAttempts(pairingId: string): Promise<number> {
    const result = await this.pool.query(
      `SELECT attempts FROM pairing_state WHERE pairing_id = $1`,
      [pairingId]
    );
    if (result.rows.length === 0) return 0;
    const attempts = result.rows[0]!.attempts as number;
    return Math.max(0, 5 - attempts);
  }

  /**
   * Delete a pairing session (after successful pairing or lockout).
   */
  async destroy(pairingId: string): Promise<void> {
    await this.pool.query(
      `DELETE FROM pairing_state WHERE pairing_id = $1`,
      [pairingId]
    );
  }

  /**
   * Check if a pairing session exists.
   */
  async exists(pairingId: string): Promise<boolean> {
    const result = await this.pool.query(
      `SELECT 1 FROM pairing_state WHERE pairing_id = $1 AND expires_at > now()`,
      [pairingId]
    );
    return result.rows.length > 0;
  }
}
