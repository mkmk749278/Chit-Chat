/**
 * `apps/mobile` — REST clients for prekey claim and phone→UID directory lookup.
 *
 * Thin wrappers over the shared {@link HttpClient} port that attach the caller's Firebase
 * bearer token and parse the typed responses. Both are TLS-only (the HttpClient adapter
 * enforces `https://`) and never log headers or bodies (Requirements 8.5–8.7).
 */

import type { HttpClient, PreKeyClaimClient } from '@chat-app/crypto';
import type { ClaimedPreKeyBundle, ResolvePhoneResponse, WhoAmIResponse } from '@chat-app/types';

/** Per-request timeout for the REST lookups (matches the registration budget, 3.8). */
const REQUEST_TIMEOUT_MS = 10_000;

/**
 * Build the {@link PreKeyClaimClient} the Messaging orchestrator uses to fetch a recipient's
 * PUBLIC prekey bundle before the first send (`GET /api/keys/:uid`). Resolves `null` when
 * the recipient has no registered device (HTTP 404) or the caller is not signed in.
 */
export function createPreKeyClaimClient(
  http: HttpClient,
  getToken: () => string | null,
  apiBaseUrl: string,
): PreKeyClaimClient {
  return {
    async claim(recipientUid: string): Promise<ClaimedPreKeyBundle | null> {
      const token = getToken();
      if (token === null) {
        return null;
      }
      const response = await http.send({
        method: 'GET',
        url: `${apiBaseUrl}/api/keys/${encodeURIComponent(recipientUid)}`,
        headers: { Authorization: `Bearer ${token}` },
        timeoutMs: REQUEST_TIMEOUT_MS,
      });
      if (response.status === 200) {
        return JSON.parse(response.body) as ClaimedPreKeyBundle;
      }
      return null;
    },
  };
}

/** Resolves an E.164 phone number to a registered user's Firebase UID for contact discovery. */
export interface DirectoryClient {
  /** Resolve a phone number to a UID, or `null` when no registered user owns it / not signed in. */
  resolve(phoneNumber: string): Promise<string | null>;
  /** Diagnostic: the caller's own discovery state (token vs stored phone, device count). */
  whoAmI(): Promise<WhoAmIResponse | null>;
}

/**
 * Build a {@link DirectoryClient} over `POST /api/directory/resolve`. The phone number rides
 * the request body (never the URL). Resolves `null` on 404 (no such user) or when not signed in.
 */
export function createDirectoryClient(
  http: HttpClient,
  getToken: () => string | null,
  apiBaseUrl: string,
): DirectoryClient {
  return {
    async resolve(phoneNumber: string): Promise<string | null> {
      const token = getToken();
      if (token === null) {
        return null;
      }
      const response = await http.send({
        method: 'POST',
        url: `${apiBaseUrl}/api/directory/resolve`,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ phoneNumber }),
        timeoutMs: REQUEST_TIMEOUT_MS,
      });
      if (response.status === 200) {
        return (JSON.parse(response.body) as ResolvePhoneResponse).uid;
      }
      return null;
    },

    async whoAmI(): Promise<WhoAmIResponse | null> {
      const token = getToken();
      if (token === null) {
        return null;
      }
      const response = await http.send({
        method: 'GET',
        url: `${apiBaseUrl}/api/directory/me`,
        headers: { Authorization: `Bearer ${token}` },
        timeoutMs: REQUEST_TIMEOUT_MS,
      });
      if (response.status === 200) {
        return JSON.parse(response.body) as WhoAmIResponse;
      }
      return null;
    },
  };
}
