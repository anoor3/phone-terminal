/**
 * Configuration validation for the phone-terminal backend.
 *
 * Security notes:
 * - TLS is mandatory (no ws:// path exists)
 * - ALLOWED_ORIGINS prevents cross-origin WS hijacking
 * - Redis/Postgres connection strings are never logged
 */

export interface Config {
  host: string;
  port: number;
  tlsCertPath: string;
  tlsKeyPath: string;
  allowedOrigins: string[];
  redisUrl: string;
  databaseUrl: string;
}

export function validateConfig(): Config {
  const missing: string[] = [];

  const tlsCertPath = process.env["TLS_CERT_PATH"];
  const tlsKeyPath = process.env["TLS_KEY_PATH"];
  const allowedOriginsRaw = process.env["ALLOWED_ORIGINS"];
  const redisUrl = process.env["REDIS_URL"];
  const databaseUrl = process.env["DATABASE_URL"];

  if (!tlsCertPath) missing.push("TLS_CERT_PATH");
  if (!tlsKeyPath) missing.push("TLS_KEY_PATH");
  if (!allowedOriginsRaw) missing.push("ALLOWED_ORIGINS");
  if (!redisUrl) missing.push("REDIS_URL");
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

  return {
    host: process.env["HOST"] ?? "0.0.0.0",
    port,
    tlsCertPath: tlsCertPath!,
    tlsKeyPath: tlsKeyPath!,
    allowedOrigins,
    redisUrl: redisUrl!,
    databaseUrl: databaseUrl!,
  };
}
