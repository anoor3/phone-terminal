import Fastify from "fastify";
import websocket from "@fastify/websocket";
import rateLimit from "@fastify/rate-limit";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { validateConfig, type Config } from "./config.js";

export async function buildServer(config: Config) {
  // TLS is mandatory — the server ONLY speaks HTTPS/WSS
  const tls = {
    cert: readFileSync(resolve(config.tlsCertPath)),
    key: readFileSync(resolve(config.tlsKeyPath)),
  };

  const server = Fastify({
    https: tls,
    logger: {
      level: process.env["LOG_LEVEL"] ?? "info",
      // Never log request bodies (could contain tokens during pairing)
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
    // Reject oversized payloads — pairing payloads are tiny
    bodyLimit: 1024 * 16, // 16KB max
  });

  // Global rate limiting (defense against abuse)
  await server.register(rateLimit, {
    global: true,
    max: 100,
    timeWindow: "1 minute",
  });

  // WebSocket support (WSS only since server is TLS)
  await server.register(websocket);

  // Health check — does not expose internal state or versions
  server.get("/health", async () => {
    return { status: "ok" };
  });

  return server;
}

async function main() {
  const config = validateConfig();
  const server = await buildServer(config);

  try {
    await server.listen({ host: config.host, port: config.port });
    server.log.info(
      `phone-terminal backend listening on https://${config.host}:${config.port}`
    );
  } catch (err) {
    server.log.error(err);
    process.exit(1);
  }

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    server.log.info(`Received ${signal}, shutting down gracefully...`);
    await server.close();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main();
