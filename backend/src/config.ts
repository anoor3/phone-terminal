/**
 * Configuration for the phone-terminal backend.
 *
 * Requires:
 * - DATABASE_URL (Supabase Postgres connection string)
 * - TLS cert/key for HTTPS/WSS
 * - ALLOWED_ORIGINS for WebSocket Origin validation
 *
 * Redis is NOT required — pairing state lives in Postgres.
 */

export interface Config {
  host: string;
  port: number;
  tlsCertPath: string | null;
  tlsKeyPath: string | null;
  allowedOrigins: string[];
  databaseUrl: string;
}

export function validateConfig(): Config {
  const missing: string[] = [];

  const allowedOriginsRaw = process.env["ALLOWED_ORIGINS"];
  const databaseUrl = process.env["DATABASE_URL"];

  if (!allowedOriginsRaw) missing.push("ALLOWED_ORIGINS");
  if (!databaseUrl) missing.push("DATABASE_URL");

  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missing.join(", ")}\n` +
      "All are mandatory — no insecure defaults exist."
    );
  }

  const allowedOrigins = allowedOriginsRaw!.split(",").map((s) => s.trim()).filter(Boolean);
  if (allowedOrigins.length === 0) {
    throw new Error("ALLOWED_ORIGINS must contain at least one origin.");
  }

  const port = parseInt(process.env["PORT"] ?? "3001", 10);
  if (isNaN(port) || port < 1 || port > 65535) {
    throw new Error("PORT must be a valid port number (1-65535).");
  }

  // TLS is optional in production (Fly.io handles TLS at the edge)
  // Required for local development (mkcert)
  const tlsCertPath = process.env["TLS_CERT_PATH"] ?? null;
  const tlsKeyPath = process.env["TLS_KEY_PATH"] ?? null;

  return {
    host: process.env["HOST"] ?? "0.0.0.0",
    port,
    tlsCertPath,
    tlsKeyPath,
    allowedOrigins,
    databaseUrl: databaseUrl!,
  };
}
