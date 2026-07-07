/**
 * Device revocation endpoint.
 *
 * Per §9:
 * - `phone-terminal revoke <deviceId>` permanently revokes that device's key
 * - Even a CURRENTLY CONNECTED session for that device is force-dropped
 * - The device can NEVER re-pair without a brand-new QR/keypair
 *
 * POST /api/devices/revoke
 * Body: { deviceId, cliInstance }
 *
 * Security:
 * - Only the CLI instance that paired the device can revoke it
 *   (matched by cli_instance column in Postgres)
 * - Revocation is permanent (revoked_at set, never cleared)
 * - Active sessions force-ended immediately
 * - Key cache cleared so even stale relay messages get rejected
 * - Rate limited to prevent abuse
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import type pg from "pg";
import { SocketRegistry } from "../ws/handler.js";
import { endSession, type DisconnectDeps } from "../ws/disconnect.js";

export interface RevocationDeps {
  pool: pg.Pool;
  socketRegistry: SocketRegistry;
  log: (level: "info" | "warn" | "error", data: Record<string, unknown>, msg: string) => void;
}

interface RevokeBody {
  deviceId: string;
  cliInstance: string;
}

export function registerRevocationRoute(
  server: FastifyInstance,
  deps: RevocationDeps
): void {
  server.post(
    "/api/devices/revoke",
    {
      config: {
        rateLimit: {
          max: 10,
          timeWindow: "1 minute",
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = request.body as Partial<RevokeBody> | null;

      if (!body || typeof body.deviceId !== "string" || typeof body.cliInstance !== "string") {
        return reply.code(400).send({ error: "deviceId and cliInstance are required" });
      }

      const { deviceId, cliInstance } = body;
      const deviceIdBuf = Buffer.from(deviceId, "base64url");

      // 1. Verify the device belongs to this CLI instance and isn't already revoked
      const deviceResult = await deps.pool.query(
        `SELECT device_id, cli_instance, revoked_at FROM devices
         WHERE device_id = $1`,
        [deviceIdBuf]
      );

      if (deviceResult.rows.length === 0) {
        return reply.code(404).send({ error: "Device not found" });
      }

      const device = deviceResult.rows[0]!;

      if (device.revoked_at) {
        return reply.code(409).send({ error: "Device already revoked" });
      }

      if (device.cli_instance !== cliInstance) {
        request.log.warn({ deviceId, cliInstance }, "Revocation attempt from non-owner CLI instance");
        return reply.code(403).send({ error: "Not authorized to revoke this device" });
      }

      // 2. Set revoked_at (permanent — never cleared)
      await deps.pool.query(
        `UPDATE devices SET revoked_at = NOW() WHERE device_id = $1`,
        [deviceIdBuf]
      );

      // 3. Force-end ANY active sessions for this device
      const activeSessions = await deps.pool.query(
        `SELECT session_id FROM sessions
         WHERE device_id = $1 AND ended_at IS NULL`,
        [deviceIdBuf]
      );

      const disconnectDeps: DisconnectDeps = {
        socketRegistry: deps.socketRegistry,
        pool: deps.pool,
        log: deps.log,
      };

      for (const row of activeSessions.rows) {
        const sessionId = (row.session_id as Buffer).toString("base64url");
        await endSession(disconnectDeps, sessionId, "revoked", "server");
      }

      deps.log("info", {
        deviceId,
        cliInstance,
        droppedSessions: activeSessions.rowCount,
      }, "Device revoked successfully");

      return reply.code(200).send({
        revoked: true,
        deviceId,
        droppedSessions: activeSessions.rowCount,
      });
    }
  );

  // Also provide a list endpoint for the CLI 'devices' command
  server.get(
    "/api/devices",
    async (request: FastifyRequest, reply: FastifyReply) => {
      const cliInstance = (request.query as Record<string, string>)["cliInstance"];

      if (!cliInstance) {
        return reply.code(400).send({ error: "cliInstance query param required" });
      }

      const result = await deps.pool.query(
        `SELECT
           encode(d.device_id, 'base64') as device_id,
           d.label,
           d.created_at,
           d.revoked_at,
           (SELECT MAX(s.paired_at) FROM sessions s WHERE s.device_id = d.device_id) as last_session,
           (SELECT COUNT(*) FROM sessions s WHERE s.device_id = d.device_id AND s.ended_at IS NULL) as active_sessions
         FROM devices d
         WHERE d.cli_instance = $1
         ORDER BY d.created_at DESC`,
        [cliInstance]
      );

      return reply.code(200).send({ devices: result.rows });
    }
  );
}
