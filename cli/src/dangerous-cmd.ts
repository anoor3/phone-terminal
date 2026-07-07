/**
 * Dangerous command detection — pattern match on input BEFORE it reaches pty.
 *
 * Per §7.1: Confirmation happens on the LAPTOP, not the phone.
 * Per §7.2: Pattern-match on the input line before it reaches the pty.
 * Per §7.3: CLI does NOT write to pty until local Y/N keypress is received.
 *
 * Detected patterns:
 * - rm -rf / rm -fr (any rm with both -r and -f flags)
 * - sudo, su -
 * - curl|sh, wget|bash (pipe-to-shell)
 * - git push --force / git push -f
 * - DROP TABLE, DELETE FROM without WHERE
 * - > /dev/sda (disk-level device writes)
 * - writes to ~/.ssh, ~/.aws (credential directories)
 *
 * Note from §7 audit trail: both approved and blocked commands are logged.
 */

import chalk from "chalk";

/**
 * Describes a matched dangerous pattern.
 */
export interface DangerousMatch {
  /** Human-readable description of why this is dangerous */
  reason: string;
  /** The pattern category that triggered */
  category: string;
}

/**
 * Check if a command matches any dangerous pattern.
 * Returns null if safe, or a DangerousMatch if dangerous.
 */
export function detectDangerousCommand(input: string): DangerousMatch | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  // rm with both -r and -f (any order, combined or separate flags)
  // Matches: rm -rf, rm -fr, rm -r -f, rm --recursive -f, etc.
  if (/\brm\b/.test(trimmed)) {
    // Check for -r and -f in any flag combination
    const hasRecursive = /-[^\s]*r/.test(trimmed) || /--recursive/.test(trimmed);
    const hasForce = /-[^\s]*f/.test(trimmed) || /--force/.test(trimmed);
    if (hasRecursive && hasForce) {
      return { reason: "Recursive forced deletion", category: "rm-rf" };
    }
  }

  // sudo
  if (/\bsudo\b/.test(trimmed)) {
    return { reason: "Elevated privilege execution", category: "sudo" };
  }

  // su - (switch to root)
  if (/\bsu\s+-/.test(trimmed) || /\bsu\s*$/.test(trimmed)) {
    return { reason: "Switch to root user", category: "su" };
  }

  // Pipe-to-shell: curl|sh, curl|bash, wget|sh, wget|bash
  if (/\b(curl|wget)\b.*\|\s*(sh|bash|zsh|fish)\b/.test(trimmed)) {
    return { reason: "Piping remote content to shell", category: "pipe-to-shell" };
  }

  // git push --force / git push -f
  if (/\bgit\s+push\b.*(\s--force\b|\s-[^\s]*f)/.test(trimmed)) {
    return { reason: "Force push overwrites remote history", category: "git-force-push" };
  }

  // DROP TABLE (case-insensitive)
  if (/\bDROP\s+TABLE\b/i.test(trimmed)) {
    return { reason: "Dropping database table", category: "drop-table" };
  }

  // DELETE FROM without WHERE (case-insensitive, best-effort heuristic)
  if (/\bDELETE\s+FROM\b/i.test(trimmed) && !/\bWHERE\b/i.test(trimmed)) {
    return { reason: "DELETE FROM without WHERE clause (deletes all rows)", category: "delete-no-where" };
  }

  // Write to /dev/sda (or any /dev/sd* block device)
  if (/>\s*\/dev\/sd[a-z]/.test(trimmed)) {
    return { reason: "Direct write to block device", category: "device-write" };
  }

  // Writes to ~/.ssh or ~/.aws
  if (/[>|]\s*~\/\.ssh\//.test(trimmed) || /\b(cp|mv|tee|cat\s*>|scp)\b.*~\/\.ssh\//.test(trimmed)) {
    return { reason: "Writing to SSH credentials directory", category: "ssh-write" };
  }
  if (/[>|]\s*~\/\.aws\//.test(trimmed) || /\b(cp|mv|tee|cat\s*>|scp)\b.*~\/\.aws\//.test(trimmed)) {
    return { reason: "Writing to AWS credentials directory", category: "aws-write" };
  }

  return null;
}

/**
 * Show a warning and prompt for Y/N confirmation on the laptop.
 *
 * Per §7.1: The confirmation happens on the LAPTOP, not the phone.
 * The laptop is the ground truth for "what is about to run."
 *
 * Returns true if the user allows the command, false if blocked.
 */
export async function confirmDangerousCommand(
  input: string,
  match: DangerousMatch
): Promise<boolean> {
  const warning = [
    "",
    chalk.yellow.bold("  ⚠  DANGEROUS COMMAND DETECTED"),
    "",
    chalk.white(`  Phone wants to run: ${chalk.red.bold(input.trim())}`),
    chalk.dim(`  Reason: ${match.reason} [${match.category}]`),
    "",
    chalk.yellow("  Press Y to allow, N to block"),
    "",
  ].join("\n");

  process.stdout.write(warning);

  return new Promise<boolean>((resolve) => {
    // We need raw mode to capture single keypresses
    const wasRaw = process.stdin.isRaw;
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
    }
    process.stdin.resume();

    const onData = (chunk: Buffer): void => {
      const key = chunk.toString().toLowerCase();

      if (key === "y") {
        cleanup();
        process.stdout.write(chalk.green("  ✓ Allowed\n\n"));
        resolve(true);
      } else if (key === "n" || key === "\x1B" || key === "\x03") {
        // N, Escape, or Ctrl+C all count as block
        cleanup();
        process.stdout.write(chalk.red("  ✗ Blocked\n\n"));
        resolve(false);
      }
      // Ignore any other key — wait for Y or N
    };

    const cleanup = (): void => {
      process.stdin.removeListener("data", onData);
      if (process.stdin.isTTY && wasRaw !== undefined) {
        process.stdin.setRawMode(wasRaw);
      }
    };

    process.stdin.on("data", onData);
  });
}

/**
 * Full check-and-confirm flow for a single input.
 *
 * This is the main entry point called from pty-io before writing to pty.
 * Returns true if the command is safe or was approved, false if blocked.
 */
export async function checkDangerousCommand(input: string): Promise<boolean> {
  const match = detectDangerousCommand(input);

  if (!match) {
    // Not dangerous — allow immediately
    return true;
  }

  // Dangerous — require laptop confirmation per §7.1
  return confirmDangerousCommand(input, match);
}
