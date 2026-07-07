/**
 * CLI code submission — reads 6-digit verification code from stdin.
 *
 * Per §3.3:
 * - Phone shows the 6-digit code (received from backend via code_challenge)
 * - User reads code off phone screen, types it into the CLI
 * - CLI sends code_submit { pairingId, code } over WebSocket
 * - Backend validates (5 attempts max) → returns result
 *
 * UX:
 * - Prompt is clear: "Enter the 6-digit code shown on your phone:"
 * - Input is NOT hidden (it's not a password — user needs to see what they typed)
 * - Invalid code: show remaining attempts
 * - Locked (5 failed): inform user to run 'connect' again
 * - Expired: inform user pairing window closed
 *
 * Security:
 * - Code is ephemeral — discarded after use
 * - Not stored anywhere on the CLI side
 * - Sent only over the authenticated WSS connection
 */

import * as readline from "node:readline";
import type WebSocket from "ws";

/**
 * Prompt the user for the 6-digit code and return it.
 * Validates format (exactly 6 digits) before sending.
 */
function promptForCode(): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    const ask = (): void => {
      rl.question("  Enter the 6-digit code shown on your phone: ", (answer) => {
        const trimmed = answer.trim();

        // Validate: must be exactly 6 digits
        if (!/^\d{6}$/.test(trimmed)) {
          console.log("  ⚠ Code must be exactly 6 digits. Try again.\n");
          ask();
          return;
        }

        rl.close();
        resolve(trimmed);
      });
    };

    ask();
  });
}

export interface CodeSubmitResult {
  success: boolean;
  error?: string;
}

/**
 * Handle the code submission flow.
 * Prompts user, sends code, waits for response, retries on failure.
 */
export async function handleCodeSubmission(
  ws: WebSocket,
  pairingId: string
): Promise<CodeSubmitResult> {
  return new Promise((resolve) => {
    let resolved = false;

    const onMessage = async (data: WebSocket.RawData): Promise<void> => {
      if (resolved) return;

      const msg = JSON.parse(data.toString()) as Record<string, unknown>;
      const type = msg["type"] as string;

      switch (type) {
        case "code_valid": {
          resolved = true;
          ws.off("message", onMessage);
          console.log("  ✓ Code accepted!\n");
          resolve({ success: true });
          break;
        }

        case "code_invalid": {
          const remaining = msg["remaining"] as number;
          console.log(`  ✗ Invalid code. ${remaining} attempt${remaining === 1 ? "" : "s"} remaining.\n`);

          if (remaining > 0) {
            // Prompt again
            const code = await promptForCode();
            ws.send(JSON.stringify({
              type: "code_submit",
              pairingId,
              code,
            }));
          }
          break;
        }

        case "code_locked": {
          resolved = true;
          ws.off("message", onMessage);
          console.log("  ✗ Maximum attempts exceeded. Run 'phone-terminal connect' again.\n");
          resolve({ success: false, error: "locked" });
          break;
        }

        case "error": {
          const error = msg["error"] as string;
          if (error === "pairing_expired") {
            resolved = true;
            ws.off("message", onMessage);
            console.log("  ✗ Pairing expired. Run 'phone-terminal connect' again.\n");
            resolve({ success: false, error: "expired" });
          }
          break;
        }
      }
    };

    ws.on("message", onMessage);

    // Start by prompting for the code
    (async () => {
      console.log("  📱 Phone connected! A verification code is displayed on your phone.\n");
      const code = await promptForCode();
      ws.send(JSON.stringify({
        type: "code_submit",
        pairingId,
        code,
      }));
    })();
  });
}
