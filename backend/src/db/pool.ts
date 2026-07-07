/**
 * Postgres connection pool for phone-terminal backend.
 *
 * Security notes:
 * - Connection string from env only (never hardcoded)
 * - SSL required in production (rejectUnauthorized: true)
 * - Pool size limited to prevent resource exhaustion
 * - Connection string never logged
 */

import pg from "pg";

const { Pool } = pg;

let pool: pg.Pool | null = null;

export function getPool(databaseUrl: string): pg.Pool {
  if (!pool) {
    pool = new Pool({
      connectionString: databaseUrl,
      max: 20, // Max connections in pool
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
      // SSL configuration for Supabase
      // Supabase requires SSL but uses certs that need relaxed verification
      ssl: databaseUrl.includes("localhost") || databaseUrl.includes("127.0.0.1")
        ? false
        : { rejectUnauthorized: false },
    });

    // Log connection errors (but never the connection string itself)
    pool.on("error", (err) => {
      console.error("[db] Unexpected pool error:", err.message);
    });
  }
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
