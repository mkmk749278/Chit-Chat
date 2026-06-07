/**
 * Mobile `HttpClient` adapter (Phase 1, task 6.5; design "Port 5: HttpClient").
 *
 * Source of truth: `.kiro/specs/phase1-client-messaging/design.md` → "Port 5: HttpClient",
 * and `requirements.md` → Requirements 8.6, 8.7.
 *
 * Binds the shared `HttpClient` port (`@chat-app/crypto`) to the React Native global
 * `fetch`, used by the `DeviceRegistrar` (POST /api/devices/register) and the prekey
 * claim (GET /api/keys/:uid).
 *
 * Security invariants (Requirements 8.6, 8.7): TLS only — the URL MUST be `https://`; a
 * non-TLS URL is refused before any network call, so no token or key material is ever
 * transmitted in cleartext. A per-request `AbortController` enforces the timeout (e.g.
 * the 10 s registration budget, 3.8). Bodies/headers (which carry the bearer token and
 * public key material) are never logged (8.5).
 */

import type { HttpClient, HttpRequest, HttpResponse } from '@chat-app/crypto';

export class ReactNativeHttpClient implements HttpClient {
  async send(request: HttpRequest): Promise<HttpResponse> {
    if (!request.url.startsWith('https://')) {
      // TLS-only: abort before transmitting any payload, token, or key (8.6, 8.7).
      throw new Error('ReactNativeHttpClient: url must be an https:// (TLS) endpoint');
    }

    const controller = new AbortController();
    const timer =
      request.timeoutMs !== undefined
        ? setTimeout(() => controller.abort(), request.timeoutMs)
        : undefined;

    try {
      const response = await fetch(request.url, {
        method: request.method,
        headers: request.headers,
        body: request.body,
        signal: controller.signal,
      });

      const headers: Record<string, string> = {};
      response.headers.forEach((value: string, key: string) => {
        headers[key] = value;
      });

      return {
        status: response.status,
        headers,
        body: await response.text(),
      };
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    }
  }
}

export function createReactNativeHttpClient(): HttpClient {
  return new ReactNativeHttpClient();
}
