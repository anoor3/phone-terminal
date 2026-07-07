/**
 * Database migration runner for phone-terminal.
 *
 * Usage: npx tsx src/db/migrate.ts
 *
 * Requires DATABASE_URL environment variable.
 * Runs all pending migrations in order.
 */

import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

async function runMigrations(): Promise<void> {
  const databaseUrl = process.env["DATABASE_URL"];
  if (!databaseUrl) {
    console.error("ERROR: DATABASE_URL environment variable is required.");
    process.exit(1);
  }

  // Dynamic import to avoid loading pg-migrate when not needed
  const { runner } = await import("node-pg-migrate");

  const migrationsDir = resolve(__dirname, "../../migrations");

  console.log(`Running migrations from: ${migrationsDir}`);

  await runner({
    databaseUrl,
    dir: migrationsDir,
    direction: "up",
    migrationsTable: "pgmigrations",
    log: (msg: string) => console.log(`[migrate] ${msg}`),
  });

  console.log("Migrations complete.");
}

runMigrations().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
