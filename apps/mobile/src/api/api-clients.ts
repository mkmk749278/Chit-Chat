/**
 * `apps/mobile` — REST clients for prekey claim and phone→UID directory lookup.
 *
 * Thin wrappers over the shared {@link HttpClient} port that attach the caller's Firebase
 * bearer token and parse the typed responses. Both are TLS-only (the HttpClient adapter
 * enforces `https://`) and never log headers or bodies (Requirements 8.5–8.7).
 */

import type { HttpClient, PreKeyClaimClient } from '@chat-app/crypto';
import type {
  ClaimedPreKeyBundle,
  GetProfileResponse,
  ResolvePhoneResponse,
  WhoAmIResponse,
} from '@chat-app/types';

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
  /** Resolve a phone number; `user` is null on miss and `status` is the HTTP status (0 = not sent). */
  resolve(phoneNumber: string): Promise<{ status: number; user: ResolvePhoneResponse | null }>;
  /**
   * Resolve a user's PUBLIC display name by their Firebase UID (reverse of {@link resolve}).
   * Returns `null` when the caller isn't signed in, the lookup fails, or no name is set — so the
   * caller falls back to the UID. Used to name an inbound sender the user never started a chat with.
   */
  getProfile(uid: string): Promise<string | null>;
  /** Diagnostic: the caller's own discovery state (token vs stored phone, device count). */
  whoAmI(): Promise<WhoAmIResponse | null>;
  /** Set the signed-in user's display name (shown to peers). Resolves true on success. */
  setProfile(displayName: string): Promise<boolean>;
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
    async resolve(phoneNumber: string): Promise<{ status: number; user: ResolvePhoneResponse | null }> {
      const token = getToken();
      if (token === null) {
        return { status: 0, user: null };
      }
      const response = await http.send({
        method: 'POST',
        url: `${apiBaseUrl}/api/directory/resolve`,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ phoneNumber }),
        timeoutMs: REQUEST_TIMEOUT_MS,
      });
      // Accept any 2xx (NestJS POST defaults to 201) so a successful lookup is never
      // misread as a miss.
      if (response.status >= 200 && response.status < 300) {
        return { status: response.status, user: JSON.parse(response.body) as ResolvePhoneResponse };
      }
      return { status: response.status, user: null };
    },

    async getProfile(uid: string): Promise<string | null> {
      const token = getToken();
      if (token === null) {
        return null;
      }
      try {
        const response = await http.send({
          method: 'GET',
          url: `${apiBaseUrl}/api/directory/profile/${encodeURIComponent(uid)}`,
          headers: { Authorization: `Bearer ${token}` },
          timeoutMs: REQUEST_TIMEOUT_MS,
        });
        if (response.status === 200) {
          const profile = JSON.parse(response.body) as GetProfileResponse;
          return profile.displayName !== null && profile.displayName.length > 0
            ? profile.displayName
            : null;
        }
      } catch {
        // Offline or backend down: fall back to the UID rather than failing the chat.
      }
      return null;
    },

    async setProfile(displayName: string): Promise<boolean> {
      const token = getToken();
      if (token === null) {
        return false;
      }
      const response = await http.send({
        method: 'POST',
        url: `${apiBaseUrl}/api/directory/profile`,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ displayName }),
        timeoutMs: REQUEST_TIMEOUT_MS,
      });
      return response.status === 204 || response.status === 200;
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
