/**
 * Status box — always-visible connection state indicator.
 *
 * Per §5.3: The laptop ALWAYS shows connection status (green/red box).
 * Re-rendered on every state change — never just printed once and scrolled away.
 *
 * Green box when connected:
 *   - Device name, session ID (first 8 chars), mode, keybindings
 *
 * Red box when disconnected:
 *   - Reason, timestamp
 */

import chalk from "chalk";
import boxen from "boxen";

export interface ConnectedInfo {
  deviceLabel: string;
  sessionId: string;
  mode?: string;
}

export interface DisconnectedInfo {
  reason: string;
  time?: Date;
}

/** Track current state for re-rendering */
let currentState: { type: "connected"; info: ConnectedInfo } | { type: "disconnected"; info: DisconnectedInfo } | null = null;

/**
 * Format the session ID as first 8 chars in two groups (e.g. "8F2A-91CE").
 */
function formatSessionId(sessionId: string): string {
  const clean = sessionId.replace(/-/g, "").slice(0, 8).toUpperCase();
  if (clean.length >= 8) {
    return `${clean.slice(0, 4)}-${clean.slice(4, 8)}`;
  }
  return clean;
}

/**
 * Build the connected status box content (green).
 */
function buildConnectedBox(info: ConnectedInfo): string {
  const mode = info.mode ?? "Remote Terminal Control";
  const sessionDisplay = formatSessionId(info.sessionId);

  const lines = [
    chalk.green.bold("● PHONE CONNECTED"),
    "",
    `Device : ${info.deviceLabel}`,
    `Session: ${sessionDisplay}`,
    `Mode   : ${mode}`,
    "",
    `${chalk.dim("Ctrl+C")}  Stop running command`,
    `${chalk.dim("Ctrl+D")}  Disconnect phone`,
  ];

  return boxen(lines.join("\n"), {
    padding: 1,
    borderColor: "green",
    borderStyle: "round",
    title: "phone-terminal",
    titleAlignment: "center",
  });
}

/**
 * Build the disconnected status box content (red).
 */
function buildDisconnectedBox(info: DisconnectedInfo): string {
  const time = info.time ?? new Date();
  const timeStr = time.toLocaleTimeString("en-US", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

  const lines = [
    chalk.red.bold("○ PHONE DISCONNECTED"),
    "",
    `Reason : ${info.reason}`,
    `Session ended at ${timeStr}`,
  ];

  return boxen(lines.join("\n"), {
    padding: 1,
    borderColor: "red",
    borderStyle: "round",
    title: "phone-terminal",
    titleAlignment: "center",
  });
}

/**
 * Clear the previous status box area and render a new one.
 * Uses ANSI escape sequences to overwrite in-place where possible.
 */
function renderBox(content: string): void {
  // Move cursor to beginning of line, clear from cursor to end of screen
  process.stdout.write("\x1B[0G");
  process.stdout.write("\x1B[0J");
  console.log(content);
}

/**
 * Render the connected status box.
 * Call this when the session transitions to the connected state.
 */
export function renderConnectedBox(info: ConnectedInfo): void {
  currentState = { type: "connected", info };
  const box = buildConnectedBox(info);
  renderBox(box);
}

/**
 * Render the disconnected status box.
 * Call this when the session transitions to the disconnected state.
 */
export function renderDisconnectedBox(info: DisconnectedInfo): void {
  currentState = { type: "disconnected", info };
  const box = buildDisconnectedBox(info);
  renderBox(box);
}

/**
 * Re-render the current status box (e.g., after terminal output scrolls it away).
 * Returns false if no state has been set yet.
 */
export function refreshStatusBox(): boolean {
  if (!currentState) return false;

  if (currentState.type === "connected") {
    const box = buildConnectedBox(currentState.info);
    renderBox(box);
  } else {
    const box = buildDisconnectedBox(currentState.info);
    renderBox(box);
  }

  return true;
}

/**
 * Get the current connection state for external queries.
 */
export function getStatusState(): typeof currentState {
  return currentState;
}

/**
 * Clear the stored state (e.g., on process exit).
 */
export function clearStatusState(): void {
  currentState = null;
}
