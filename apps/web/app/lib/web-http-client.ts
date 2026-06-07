/**
 * Web `HttpClient` adapter (Phase 1, task 7.5; design Client Component 5 / "Ports").
 *
 * Source of truth: `.kiro/specs/phase1-client-messaging/design.md` →
 *   "Port 5: HttpClient", and `requirements.md` → Requirements 8.6, 8.7.
 *
 * Binds the shared `HttpClient` port (from `@chat-app/crypto`) to the browser `fetch`
 * API, used by the `DeviceRegistrar` (POST /api/devices/register) and the prekey-claim
 * (GET /api/keys/:uid).
 *
 * Security invariants enforced here (Requirements 8.6, 8.7):
 *   - TLS only: the request URL MUST be `https://`; a non-TLS URL is refused before any
 *     network call, so no token or key material is ever transmitted in cleartext.
 *   - A per-request timeout (e.g. the 10 s registration budget, 3.8) aborts the in-flight
 *     request via `AbortController`; the shared core maps the abort onto its backoff path.
 *
 * The adapter never logs the request/response bodies or headers (they carry the bearer
 * token and public key material), keeping secrets out of any diagnostic (8.5).
 */

import type { HttpClient, HttpRequest, HttpResponse } from '@chat-app/crypto';

export class WebHttpClient implements HttpClient {
  async send(request: HttpRequest): Promise<HttpResponse> {
    if (!request.url.startsWith('https://')) {
      // TLS-only: abort before transmitting any payload, token, or key material (8.6, 8.7).
      throw new Error('WebHttpClient: url must be an https:// (TLS) endpoint');
    }

    // Arm the per-request timeout (e.g. registration's 10 s, Requirement 3.8). Cleared in
    // `finally` so a completed request never leaves a dangling timer.
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
        // Never attach ambient cookies/credentials; auth rides the explicit bearer header.
        credentials: 'omit',
        cache: 'no-store',
      });

      return {
        status: response.status,
        headers: Object.fromEntries(response.headers.entries()),
        body: await response.text(),
      };
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    }
  }
}

/** Convenience factory mirroring the ports-and-adapters style of the shared core. */
export function createWebHttpClient(): HttpClient {
  return new WebHttpClient();
}
