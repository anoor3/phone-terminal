/**
 * Idle timeout tracker for phone-terminal sessions.
 *
 * Per §5.5: If no input is received for 15 minutes, the session
 * is automatically disconnected to prevent zombie sessions.
 *
 * Design:
 * - Tracks last input timestamp per session
 * - A single setInterval sweeps all sessions every 60 seconds
 * - If lastInput + IDLE_TIMEOUT_MS < now → endSession with reason 'timeout'
 * - Timer resets on any verified input/resize message from the phone
 * - Both sides are notified on timeout
 *
 * Security rationale:
 * - Prevents sessions from lingering indefinitely if the phone loses connectivity
 * - Ensures "no session outlives its purpose" even without explicit disconnect
 * - The sweep interval (60s) means worst-case disconnect is 15:59 — acceptable
 */

import type pg from "pg";
import { SocketRegistry } from "./handler.js";
import { endSession } from "./disconnect.js";

/** 15 minutes in milliseconds */
const IDLE_TIMEOUT_MS = 900_000;

/** Sweep interval — check all sessions every 60 seconds */
const SWEEP_INTERVAL_MS = 60_000;

interface IdleEntry {
  sessionId: string;
  lastActivity: number;
}

/** Map of sessionId → last activity timestamp */
const sessions = new Map<string, IdleEntry>();

/** The sweep interval handle */
let sweepInterval: ReturnType<typeof setInterval> | null = null;

export interface IdleTimeoutDeps {
  socketRegistry: SocketRegistry;
  pool: pg.Pool;
  log: (level: "info" | "warn" | "error", data: Record<string, unknown>, msg: string) => void;
}

/** Shared deps reference — set once on init */
let deps: IdleTimeoutDeps | null = null;

/**
 * Initialize the idle timeout system.
 * Call once during server startup.
 */
export function initIdleTimeout(d: IdleTimeoutDeps): void {
  deps = d;

  if (sweepInterval) {
    clearInterval(sweepInterval);
  }

  sweepInterval = setInterval(() => {
    void sweepIdleSessions();
  }, SWEEP_INTERVAL_MS);

  // Don't keep the process alive just for this timer
  if (sweepInterval.unref) {
    sweepInterval.unref();
  }
}

/**
 * Stop the idle timeout system.
 * Call during graceful shutdown.
 */
export function shutdownIdleTimeout(): void {
  if (sweepInterval) {
    clearInterval(sweepInterval);
    sweepInterval = null;
  }
  sessions.clear();
  deps = null;
}

/**
 * Start tracking idle time for a session.
 * Called when a session becomes active (pairing completes).
 */
export function startIdleTimer(sessionId: string): void {
  sessions.set(sessionId, {
    sessionId,
    lastActivity: Date.now(),
  });
}

/**
 * Reset the idle timer for a session.
 * Called on each verified input/resize message from the phone.
 */
export function resetIdleTimer(sessionId: string): void {
  const entry = sessions.get(sessionId);
  if (entry) {
    entry.lastActivity = Date.now();
  }
}

/**
 * Stop tracking idle time for a session.
 * Called when a session ends (disconnect, revoke, etc.).
 */
export function stopIdleTimer(sessionId: string): void {
  sessions.delete(sessionId);
}

/**
 * Sweep all active sessions and disconnect any that have been idle
 * for longer than IDLE_TIMEOUT_MS.
 */
async function sweepIdleSessions(): Promise<void> {
  if (!deps) return;

  const now = Date.now();
  const timedOut: string[] = [];

  for (const [sessionId, entry] of sessions) {
    if (now - entry.lastActivity >= IDLE_TIMEOUT_MS) {
      timedOut.push(sessionId);
    }
  }

  for (const sessionId of timedOut) {
    deps.log("info", { sessionId, idleMs: IDLE_TIMEOUT_MS }, "idle-timeout: session timed out");

    // Remove from tracking before ending (prevent re-sweep)
    sessions.delete(sessionId);

    try {
      await endSession(deps, sessionId, "timeout", "server");
    } catch (err) {
      deps.log("error", { sessionId, error: (err as Error).message }, "idle-timeout: failed to end session");
    }
  }
}

/**
 * Get the number of currently tracked sessions (for monitoring/tests).
 */
export function getTrackedSessionCount(): number {
  return sessions.size;
}
