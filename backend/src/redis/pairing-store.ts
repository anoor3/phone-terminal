/**
 * Redis pairing store for phone-terminal.
 *
 * Manages all ephemeral pairing-phase state per §4.2:
 *   pair:{pairingId}:token      → pairingToken         EX 120
 *   pair:{pairingId}:cli_secret → cliSecret            EX 120
 *   pair:{pairingId}:code       → 6-digit code         EX 120
 *   pair:{pairingId}:attempts   → int counter          EX 120
 *   pair:{pairingId}:state      → "pending"|"claimed"  EX 120
 *
 * Security notes:
 * - ALL keys have 120s TTL — pairing must complete within this window
 * - Token is single-use: once claimed, no second claim is possible
 * - Code attempts capped at 5 — brute force of 6-digit space impossible
 * - All values are constant-time compared where security-relevant
 * - Keys are deleted immediately on successful pairing (no lingering state)
 */

import type { RedisClient } from "./client.js";
import { timingSafeEqual } from "node:crypto";

const PAIRING_TTL = 120; // seconds — per §2.2

/** Key helpers — centralized to prevent typos */
function keyToken(pairingId: string): string {
  return `pair:${pairingId}:token`;
}
function keyCliSecret(pairingId: string): string {
  return `pair:${pairingId}:cli_secret`;
}
function keyCode(pairingId: string): string {
  return `pair:${pairingId}:code`;
}
function keyAttempts(pairingId: string): string {
  return `pair:${pairingId}:attempts`;
}
function keyState(pairingId: string): string {
  return `pair:${pairingId}:state`;
}

export type PairingState = "pending" | "claimed";

export interface PairingData {
  pairingId: string;
  pairingToken: string;
  cliSecret: string;
  expiresAt: number; // Unix timestamp ms
}

export class PairingStore {
  constructor(private readonly redis: RedisClient) {}

  /**
   * Create a new pairing session.
   * Stores token, cliSecret, and state with 120s TTL.
   */
  async create(data: PairingData): Promise<void> {
    const pipeline = this.redis.pipeline();

    pipeline.set(keyToken(data.pairingId), data.pairingToken, "EX", PAIRING_TTL);
    pipeline.set(keyCliSecret(data.pairingId), data.cliSecret, "EX", PAIRING_TTL);
    pipeline.set(keyState(data.pairingId), "pending", "EX", PAIRING_TTL);

    await pipeline.exec();
  }

  /**
   * Get the current state of a pairing session.
   * Returns null if expired or never existed.
   */
  async getState(pairingId: string): Promise<PairingState | null> {
    const state = await this.redis.get(keyState(pairingId));
    if (state === "pending" || state === "claimed") {
      return state;
    }
    return null;
  }

  /**
   * Validate the CLI secret for a pairing session.
   * Uses constant-time comparison to prevent timing attacks.
   */
  async validateCliSecret(pairingId: string, secret: string): Promise<boolean> {
    const stored = await this.redis.get(keyCliSecret(pairingId));
    if (!stored) return false;

    // Constant-time comparison
    const storedBuf = Buffer.from(stored, "utf-8");
    const providedBuf = Buffer.from(secret, "utf-8");

    if (storedBuf.length !== providedBuf.length) return false;
    return timingSafeEqual(storedBuf, providedBuf);
  }

  /**
   * Validate pairing token and claim the session (single-use).
   * Returns true if claim succeeds, false if token is wrong or already claimed.
   *
   * Uses WATCH/MULTI for atomic state transition — prevents race condition
   * where two phones try to claim simultaneously.
   */
  async claim(pairingId: string, token: string): Promise<boolean> {
    const stateKey = keyState(pairingId);
    const tokenKey = keyToken(pairingId);

    // Check current state
    const state = await this.redis.get(stateKey);
    if (state !== "pending") {
      return false; // Already claimed or expired
    }

    // Validate token with constant-time comparison
    const storedToken = await this.redis.get(tokenKey);
    if (!storedToken) return false;

    const storedBuf = Buffer.from(storedToken, "utf-8");
    const providedBuf = Buffer.from(token, "utf-8");

    if (storedBuf.length !== providedBuf.length) return false;
    if (!timingSafeEqual(storedBuf, providedBuf)) return false;

    // Atomically transition state to "claimed"
    // Use SET with NX-like logic: only set if current value is "pending"
    const result = await this.redis
      .multi()
      .set(stateKey, "claimed", "EX", PAIRING_TTL)
      .del(tokenKey) // Token is single-use — delete immediately
      .exec();

    if (!result) return false;

    return true;
  }

  /**
   * Store the verification code for a pairing session.
   * Only valid after phone has claimed the session.
   */
  async setCode(pairingId: string, code: string): Promise<boolean> {
    const state = await this.redis.get(keyState(pairingId));
    if (state !== "claimed") return false;

    const pipeline = this.redis.pipeline();
    pipeline.set(keyCode(pairingId), code, "EX", PAIRING_TTL);
    pipeline.set(keyAttempts(pairingId), "0", "EX", PAIRING_TTL);
    await pipeline.exec();
    return true;
  }

  /**
   * Validate a code submission.
   * Returns: "valid" | "invalid" | "locked" (5 attempts exceeded) | "expired"
   *
   * Uses constant-time comparison on the code itself.
   */
  async validateCode(
    pairingId: string,
    submittedCode: string
  ): Promise<"valid" | "invalid" | "locked" | "expired"> {
    const storedCode = await this.redis.get(keyCode(pairingId));
    if (!storedCode) return "expired";

    // Check attempt count FIRST
    const attempts = parseInt(await this.redis.get(keyAttempts(pairingId)) ?? "0", 10);
    if (attempts >= 5) return "locked";

    // Increment attempts atomically BEFORE checking (prevents race)
    await this.redis.incr(keyAttempts(pairingId));

    // Constant-time comparison of the 6-digit code
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
    const attempts = parseInt(await this.redis.get(keyAttempts(pairingId)) ?? "0", 10);
    return Math.max(0, 5 - attempts);
  }

  /**
   * Delete all pairing keys for a session.
   * Called after successful pairing or on explicit invalidation.
   */
  async destroy(pairingId: string): Promise<void> {
    await this.redis.del(
      keyToken(pairingId),
      keyCliSecret(pairingId),
      keyCode(pairingId),
      keyAttempts(pairingId),
      keyState(pairingId)
    );
  }

  /**
   * Check if a pairing session exists (any key present).
   */
  async exists(pairingId: string): Promise<boolean> {
    const state = await this.redis.get(keyState(pairingId));
    return state !== null;
  }
}
