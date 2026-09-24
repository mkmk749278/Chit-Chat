import 'reflect-metadata';
import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { WsAdapter } from '@nestjs/platform-ws';
import { json, urlencoded } from 'express';
import { AppModule } from './app.module';

/**
 * REST/HTTP listen port. Caddy reverse-proxies the `api.` subdomain here (§9.4).
 */
const HTTP_PORT = Number(process.env.PORT ?? 3000);

/**
 * WebSocket listen port (default 3001) is owned by the RealtimeModule — the
 * RealtimeGateway binds it via the `ws` adapter (see `realtime/realtime.constants.ts`).
 * Caddy reverse-proxies the `ws.` subdomain there (§9.4), keeping the REST :3000 +
 * WS :3001 contract fixed from Phase 0.
 */

/**
 * Largest JSON body accepted by the attachment upload route. 8 MiB of ciphertext (MAX_BLOB_BYTES)
 * base64-encodes to ~10.7 MiB; 12 MiB leaves room for the JSON framing. The blob service still
 * enforces the exact byte bound before any write.
 */
const BLOB_BODY_LIMIT = '12mb';

/**
 * Largest JSON body accepted everywhere else. The biggest legitimate payload is a device
 * registration with its one-time prekey batch (tens of KB). Body parsing runs BEFORE the auth
 * guard, so this is also what an unauthenticated caller can make the server buffer per request.
 */
const DEFAULT_BODY_LIMIT = '256kb';

async function bootstrap(): Promise<void> {
  const logger = new Logger('Bootstrap');

  // Never let a stray rejection from a best-effort async path (a Redis blip in a fire-and-forget
  // push/cleanup) take down the process and every live WebSocket with it. Logged, not swallowed.
  process.on('unhandledRejection', (reason) => {
    const message = reason instanceof Error ? `${reason.name}: ${reason.message}` : String(reason);
    logger.error(`Unhandled promise rejection: ${message}`);
  });

  // Replace the default body-parser with per-route limits: the large limit applies ONLY to the
  // blob upload route (registered first, so it parses that body and the global parser then skips
  // it); every other route keeps a small bound.
  const app = await NestFactory.create(AppModule, { bodyParser: false });
  app.use('/api/blobs', json({ limit: BLOB_BODY_LIMIT }));
  app.use(json({ limit: DEFAULT_BODY_LIMIT }));
  app.use(urlencoded({ extended: false, limit: DEFAULT_BODY_LIMIT }));

  // Run the lifecycle shutdown hooks on SIGTERM/SIGINT (a redeploy stops the container with
  // SIGTERM). Without this the process just dies: live sockets are cut without a close frame and
  // the realtime gateway never withdraws its presence entries, so peers' messages were routed to a
  // dead node. The gateway's `beforeApplicationShutdown` now drains cleanly instead.
  app.enableShutdownHooks();

  // Global request validation for every DTO-bound endpoint.
  // - whitelist: strip properties not declared on the DTO.
  // - forbidNonWhitelisted: reject (400) payloads carrying unknown properties.
  // - transform: coerce incoming payloads into their DTO class instances.
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  // --- Realtime gateway (WebSocket :3001) ---
  // The RealtimeModule's RealtimeGateway binds WS_PORT via the `ws` adapter (NOT
  // Socket.IO), keeping the REST :3000 + WS :3001 contract fixed from Phase 0.
  app.useWebSocketAdapter(new WsAdapter(app));

  await app.listen(HTTP_PORT);
}

void bootstrap();
