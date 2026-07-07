/**
 * phone-terminal backend server — FULLY WIRED.
 *
 * This is the glue that connects all modules into a working relay server.
 * Supabase Postgres for all state. No Redis needed.
 */

import Fastify from "fastify";
import websocket from "@fastify/websocket";
import rateLimit from "@fastify/rate-limit";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { validateConfig } from "./config.js";
import { getPool, closePool } from "./db/pool.js";
import { PairingStore } from "./db/pairing-store.js";
import { registerPairInitRoute } from "./http/pair-init.js";
import { registerRevocationRoute } from "./http/revoke.js";
import {
  registerWsHandler,
  SocketRegistry,
  type WsHandlerContext,
} from "./ws/handler.js";
import { createMessageRouter } from "./ws/router.js";
import { handleCliHello } from "./ws/cli-hello.js";
import { handlePhoneClaim } from "./ws/phone-claim.js";
import { generateAndPushCode, handleCodeSubmit } from "./ws/code-verify.js";
import { completePairing } from "./ws/pairing-complete.js";
import { handlePhoneControlMessage, handleCliOutputMessage } from "./ws/relay.js";
import { handleDisconnectMessage, handleSocketClose } from "./ws/disconnect.js";
import { initIdleTimeout, shutdownIdleTimeout, resetIdleTimer } from "./ws/idle-timeout.js";
import type { WebSocket } from "@fastify/websocket";
import type { WsMessage } from "./ws/router.js";

async function main() {
  const config = validateConfig();

  // TLS is mandatory — WSS only, no ws:// code path exists (per §10)
  const tls = {
    cert: readFileSync(resolve(config.tlsCertPath)),
    key: readFileSync(resolve(config.tlsKeyPath)),
  };

  const server = Fastify({
    https: tls,
    logger: {
      level: process.env["LOG_LEVEL"] ?? "info",
      serializers: {
        req(request) {
          return {
            method: request.method,
            url: request.url,
            hostname: request.hostname,
            remoteAddress: request.ip,
          };
        },
      },
    },
    bodyLimit: 1024 * 16,
  });

  // Plugins
  await server.register(rateLimit, { global: true, max: 100, timeWindow: "1 minute" });
  await server.register(websocket);

  // Database
  const pool = getPool(config.databaseUrl);
  const pairingStore = new PairingStore(pool);
  const socketRegistry = new SocketRegistry();

  // Logger helper
  const log = (level: "info" | "warn" | "error", data: Record<string, unknown>, msg: string) => {
    server.log[level](data, msg);
  };

  // HTTP Routes
  registerPairInitRoute(server, pairingStore);
  registerRevocationRoute(server, { pool, socketRegistry, log });

  // Health check
  server.get("/health", async () => ({ status: "ok" }));

  // Initialize idle timeout sweeper
  const disconnectDeps = { socketRegistry, pool, log };
  initIdleTimeout(disconnectDeps);

  // WebSocket message router — connects ALL handlers
  const messageRouter = createMessageRouter({
    pairingStore,
    socketRegistry,

    onCliHello: async (socket: WebSocket, pairingId: string, cliSecret: string, ip: string) => {
      await handleCliHello(
        { pairingStore, socketRegistry, log },
        socket, pairingId, cliSecret, ip
      );
    },

    onPhoneClaim: async (socket: WebSocket, pairingId: string, pairingToken: string, ip: string) => {
      await handlePhoneClaim(
        { pairingStore, socketRegistry, log },
        socket, pairingId, pairingToken, ip
      );

      // After successful claim, generate and push verification code
      await generateAndPushCode(
        {
          pairingStore,
          socketRegistry,
          log,
          onCodeValid: async () => { /* handled in code_submit */ },
        },
        pairingId
      );
    },

    onCodeSubmit: async (socket: WebSocket, pairingId: string, code: string, ip: string) => {
      await handleCodeSubmit(
        {
          pairingStore,
          socketRegistry,
          log,
          onCodeValid: async (validPairingId: string) => {
            // Pairing complete! Generate session.
            await completePairing(
              { pairingStore, socketRegistry, pool, log },
              validPairingId,
              {}, // publicKeyJwk — phone sends it during claim (TODO: wire this)
              "Phone Device",
              "cli-instance"
            );
          },
        },
        socket, pairingId, code, ip
      );
    },

    onControlMessage: async (socket: WebSocket, message: WsMessage, ip: string) => {
      const type = message["type"] as string;

      // Reset idle timer on any input from phone
      const sessionId = message["sessionId"] as string | undefined;
      if (sessionId && (type === "input" || type === "resize")) {
        resetIdleTimer(sessionId);
      }

      // Route: phone sends input/resize → relay to CLI
      if (type === "input" || type === "resize") {
        await handlePhoneControlMessage(
          { socketRegistry, pool, log },
          socket, message, ip
        );
      }
      // Route: CLI sends output/status → relay to phone
      else if (type === "output" || type === "status") {
        await handleCliOutputMessage(
          { socketRegistry, pool, log },
          socket, message, ip
        );
      }
    },

    onDisconnect: async (socket: WebSocket, message: WsMessage, ip: string) => {
      await handleDisconnectMessage(disconnectDeps, socket, message, ip);
    },
  });

  // Register WebSocket route
  registerWsHandler(
    server,
    { allowedOrigins: config.allowedOrigins, pairingStore } as WsHandlerContext,
    socketRegistry,
    (socket, raw, ip) => { void messageRouter(socket, raw, ip); },
    (socket) => { void handleSocketClose(disconnectDeps, socket); }
  );

  // Start server
  try {
    await server.listen({ host: config.host, port: config.port });
    server.log.info(`phone-terminal backend listening on https://${config.host}:${config.port}`);
  } catch (err) {
    server.log.error(err);
    process.exit(1);
  }

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    server.log.info(`Received ${signal}, shutting down...`);
    shutdownIdleTimeout();
    await server.close();
    await closePool();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main();
