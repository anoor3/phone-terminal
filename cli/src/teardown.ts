/**
 * CLI teardown handlers — signal-based session cleanup per §5.5.
 *
 * Ensures best-effort disconnect message to backend before exiting,
 * regardless of how the process terminates.
 *
 * Signal behavior:
 * - SIGINT:  Only handle if no pty is running (otherwise SIGINT forwards to pty child)
 * - SIGTERM: Always trigger teardown
 * - SIGHUP:  Always trigger teardown (terminal closed)
 * - exit:    Last-ditch synchronous cleanup (cannot await, cannot send async)
 *
 * Security:
 * - No session outlives the CLI process (§5.5)
 * - Disconnect message sent best-effort so backend can clean up
 * - pty killed so child processes don't orphan
 */

import type { SessionState } from "./session.js";
import { teardownSession } from "./session.js";

/**
 * Register all teardown signal handlers for the given session state.
 * Should be called once after the session enters the connected state.
 */
export function registerTeardownHandlers(state: SessionState): void {
  let tornDown = false;

  function performTeardown(reason: string): void {
    if (tornDown) return;
    tornDown = true;

    if (state.connected) {
      teardownSession(state, reason);
    }
  }

  // SIGINT: only handle if no pty is actively running a foreground process.
  // When a pty is running, SIGINT is delivered to the pty's foreground process
  // group (e.g., the child shell or its children). We only intercept it for
  // teardown when the pty process itself has already exited.
  process.on("SIGINT", () => {
    // If pty is still alive, let the signal pass through to the child
    // (node-pty handles forwarding automatically via the process group).
    // We only tear down if the session is connected but the pty has already exited.
    try {
      // node-pty's pid is 0 or throws after exit
      const pid = state.ptyProcess.pid;
      if (pid > 0) {
        // pty still alive — don't intercept, let it be forwarded
        return;
      }
    } catch {
      // pty already dead — proceed with teardown
    }

    performTeardown("sigint");
    process.exit(130); // Standard SIGINT exit code: 128 + 2
  });

  // SIGTERM: always trigger teardown (graceful stop)
  process.on("SIGTERM", () => {
    performTeardown("sigterm");
    process.exit(143); // Standard SIGTERM exit code: 128 + 15
  });

  // SIGHUP: always trigger teardown (terminal hung up)
  process.on("SIGHUP", () => {
    performTeardown("sighup");
    process.exit(129); // Standard SIGHUP exit code: 128 + 1
  });

  // process.on('exit'): last-ditch synchronous cleanup.
  // By this point we can't do async work, but we can try to
  // send a sync WS message if the socket is still open.
  process.on("exit", () => {
    if (tornDown) return;

    // Best-effort sync cleanup — teardownSession is mostly sync
    // (ws.send is buffered, pty.kill is sync, state flags are sync)
    if (state.connected) {
      state.connected = false;

      // Kill pty (sync)
      try {
        state.ptyProcess.kill();
      } catch {
        // Already dead
      }

      // Try to send disconnect (ws.send is sync in Node.js ws library)
      if (state.ws.readyState === 1) {
        try {
          state.ws.send(
            JSON.stringify({
              type: "disconnect",
              sessionId: state.sessionId,
              reason: "process_exit",
            })
          );
        } catch {
          // Best effort — nothing more we can do in 'exit' handler
        }
      }
    }
  });
}
