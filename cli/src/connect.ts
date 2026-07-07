/**
 * CLI 'connect' command — initiates pairing and opens WebSocket.
 *
 * Per §3.3 sequence:
 * 1. POST /api/pair/init → get pairingId, pairingToken, cliSecret, expiresAt
 * 2. Render QR code: https://{host}/p/{pairingId}#{pairingToken}
 *    (token in fragment — never sent to server in HTTP)
 * 3. Open WSS connection to backend
 * 4. Send cli_hello { pairingId, cliSecret } to authenticate
 * 5. Wait for phone_claimed → then wait for code input
 * 6. On paired event → transition to control session
 *
 * Security:
 * - Backend URL must be wss:// (enforced, no ws:// fallback)
 * - pairingToken in URL fragment only
 * - cliSecret never shown to user or logged
 * - Countdown timer shows expiry (120s)
 * - CLI instance ID generated per process (identifies this session)
 */

import { randomBytes } from "node:crypto";
import WebSocket from "ws";
import qrcode from "qrcode-terminal";

export interface ConnectConfig {
  /** Backend API base URL (https://...) */
  apiBaseUrl: string;
  /** Backend WebSocket URL (wss://...) */
  wsUrl: string;
  /** Phone app pairing page base URL */
  pairingPageUrl: string;
}

function loadConnectConfig(): ConnectConfig {
  const apiBaseUrl = process.env["PHONE_TERMINAL_API_URL"] ?? "";
  const wsUrl = process.env["PHONE_TERMINAL_WS_URL"] ?? "";
  const pairingPageUrl = process.env["PHONE_TERMINAL_PAIRING_URL"] ?? "";

  if (!apiBaseUrl || !wsUrl || !pairingPageUrl) {
    console.error("Required environment variables:");
    console.error("  PHONE_TERMINAL_API_URL   — Backend API (e.g. https://localhost:3001)");
    console.error("  PHONE_TERMINAL_WS_URL    — Backend WS  (e.g. wss://localhost:3001/ws)");
    console.error("  PHONE_TERMINAL_PAIRING_URL — Phone page (e.g. https://pair.yourapp.com/p)");
    process.exit(1);
  }

  // WSS only — no ws:// code path exists (per §10)
  if (!wsUrl.startsWith("wss://")) {
    console.error("ERROR: PHONE_TERMINAL_WS_URL must use wss:// (no plaintext WebSocket allowed)");
    process.exit(1);
  }

  // Enforce HTTPS for API
  if (!apiBaseUrl.startsWith("https://")) {
    console.error("ERROR: PHONE_TERMINAL_API_URL must use https://");
    process.exit(1);
  }

  return { apiBaseUrl, wsUrl, pairingPageUrl };
}

/** Unique identifier for this CLI process instance */
const cliInstance = randomBytes(16).toString("base64url");

export function getCliInstance(): string {
  return cliInstance;
}

interface PairInitResponse {
  pairingId: string;
  pairingToken: string;
  cliSecret: string;
  expiresAt: number;
}

/**
 * Call POST /api/pair/init to start a new pairing session.
 */
async function callPairInit(apiBaseUrl: string): Promise<PairInitResponse> {
  const url = `${apiBaseUrl}/api/pair/init`;

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`/api/pair/init failed (${response.status}): ${text}`);
  }

  return response.json() as Promise<PairInitResponse>;
}

/**
 * Render the QR code in the terminal.
 * URL format: https://{pairingPageUrl}/{pairingId}#{pairingToken}
 * Token in fragment = never sent to server.
 */
function renderQR(pairingPageUrl: string, pairingId: string, pairingToken: string): void {
  const url = `${pairingPageUrl}/${pairingId}#${pairingToken}`;

  console.log("\n  Scan this QR code with your phone:\n");
  qrcode.generate(url, { small: true }, (code: string) => {
    // Indent the QR code for better visual presentation
    const indented = code.split("\n").map((line: string) => `  ${line}`).join("\n");
    console.log(indented);
  });
  console.log(`\n  Or open: ${pairingPageUrl}/${pairingId}#[token-hidden]`);
  console.log("  (Token is in the URL fragment — never sent to server)\n");
}

export interface ConnectSession {
  ws: WebSocket;
  pairingId: string;
  cliSecret: string;
  expiresAt: number;
  config: ConnectConfig;
}

/**
 * Execute the connect command.
 * Returns the active WebSocket and session info for further handling.
 */
export async function executeConnect(): Promise<ConnectSession> {
  const config = loadConnectConfig();

  console.log("  Initializing pairing session...\n");

  // 1. Call /api/pair/init
  const { pairingId, pairingToken, cliSecret, expiresAt } = await callPairInit(config.apiBaseUrl);

  // 2. Render QR code
  renderQR(config.pairingPageUrl, pairingId, pairingToken);

  // 3. Show countdown
  const secondsRemaining = Math.floor((expiresAt - Date.now()) / 1000);
  console.log(`  ⏱  Pairing expires in ${secondsRemaining}s — scan now!\n`);

  // 4. Open WSS connection
  const ws = new WebSocket(config.wsUrl, {
    // Reject self-signed certs in production, allow in dev
    rejectUnauthorized: process.env["NODE_ENV"] === "production",
  });

  return new Promise<ConnectSession>((resolve, reject) => {
    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error("WebSocket connection timed out"));
    }, 10_000);

    ws.on("open", () => {
      clearTimeout(timeout);

      // 5. Send cli_hello to authenticate
      ws.send(JSON.stringify({
        type: "cli_hello",
        pairingId,
        cliSecret,
      }));

      resolve({
        ws,
        pairingId,
        cliSecret,
        expiresAt,
        config,
      });
    });

    ws.on("error", (err) => {
      clearTimeout(timeout);
      reject(new Error(`WebSocket connection failed: ${err.message}`));
    });
  });
}
