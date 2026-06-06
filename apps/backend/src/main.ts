import 'reflect-metadata';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { WsAdapter } from '@nestjs/platform-ws';
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

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);

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
