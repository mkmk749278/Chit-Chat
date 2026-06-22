/**
 * `apps/mobile` — REST clients for prekey claim, phone→UID directory lookup, push-token
 * registration, and the E2E attachment blob store.
 *
 * Thin wrappers over the shared {@link HttpClient} port that attach the caller's Firebase
 * bearer token and parse the typed responses. Both are TLS-only (the HttpClient adapter
 * enforces `https://`) and never log headers or bodies (Requirements 8.5–8.7).
 */

import { Buffer } from 'buffer';

import type { BlobStore, HttpClient, PreKeyClaimClient } from '@chat-app/crypto';
import type {
  ClaimedPreKeyBundle,
  DownloadBlobResponse,
  GetProfileResponse,
  PresenceResponse,
  ResolvePhoneResponse,
  SetPushTokenRequest,
  UploadBlobRequest,
  UploadBlobResponse,
  WhoAmIResponse,
} from '@chat-app/types';

/** Per-request timeout for the REST lookups (matches the registration budget, 3.8). */
const REQUEST_TIMEOUT_MS = 10_000;

/**
 * Per-request timeout for blob upload/download. Larger than the metadata lookups above because
 * attachment ciphertext can be sizeable (a photo, not a few hundred bytes of JSON).
 */
const BLOB_REQUEST_TIMEOUT_MS = 30_000;

/**
 * Build the {@link BlobStore} the Messaging orchestrator uses to move ENCRYPTED attachment
 * ciphertext (Req 7.1): `put` → `POST /api/blobs`, `get` → `GET /api/blobs/:id`. The bytes are
 * opaque, client-encrypted ciphertext — the per-attachment key NEVER touches this transport (it
 * rides the E2E `attachment` payload, Req 7.2). base64 is the wire encoding on both ends.
 *
 * Both methods THROW on a missing token / non-2xx / malformed body so the orchestrator marks the
 * outbound message `failed` (on `put`) or surfaces an inbound delivery-error (on `get`) instead of
 * silently dropping the attachment.
 */
export function createBlobStore(
  http: HttpClient,
  getToken: () => string | null,
  apiBaseUrl: string,
): BlobStore {
  return {
    async put(ciphertext: Uint8Array): Promise<string> {
      const token = getToken();
      if (token === null) {
        throw new Error('blob upload: not signed in');
      }
      const response = await http.send({
        method: 'POST',
        url: `${apiBaseUrl}/api/blobs`,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ciphertext: Buffer.from(ciphertext).toString('base64'),
        } satisfies UploadBlobRequest),
        timeoutMs: BLOB_REQUEST_TIMEOUT_MS,
      });
      if (response.status < 200 || response.status >= 300) {
        throw new Error(`blob upload failed (HTTP ${response.status})`);
      }
      const { blobId } = JSON.parse(response.body) as UploadBlobResponse;
      if (typeof blobId !== 'string' || blobId.length === 0) {
        throw new Error('blob upload: malformed response');
      }
      return blobId;
    },

    async get(blobId: string): Promise<Uint8Array> {
      const token = getToken();
      if (token === null) {
        throw new Error('blob download: not signed in');
      }
      const response = await http.send({
        method: 'GET',
        url: `${apiBaseUrl}/api/blobs/${encodeURIComponent(blobId)}`,
        headers: { Authorization: `Bearer ${token}` },
        timeoutMs: BLOB_REQUEST_TIMEOUT_MS,
      });
      if (response.status < 200 || response.status >= 300) {
        throw new Error(`blob download failed (HTTP ${response.status})`);
      }
      const { ciphertext } = JSON.parse(response.body) as DownloadBlobResponse;
      if (typeof ciphertext !== 'string') {
        throw new Error('blob download: malformed response');
      }
      return new Uint8Array(Buffer.from(ciphertext, 'base64'));
    },
  };
}

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

/**
 * Build a client for `POST /api/devices/push-token` (Phase 2, Req 6.2/6.4). Registers (or, with an
 * empty token, revokes) this device's platform push token so the backend can send content-free wake
 * pushes when the user is offline. The device is selected by its libsignal `registrationId`.
 */
export function createPushTokenClient(
  http: HttpClient,
  getToken: () => string | null,
  apiBaseUrl: string,
): PushTokenClient {
  return {
    async setPushToken(registrationId: number, pushToken: string): Promise<boolean> {
      const token = getToken();
      if (token === null) {
        return false;
      }
      try {
        const response = await http.send({
          method: 'POST',
          url: `${apiBaseUrl}/api/devices/push-token`,
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ registrationId, pushToken } satisfies SetPushTokenRequest),
          timeoutMs: REQUEST_TIMEOUT_MS,
        });
        return response.status >= 200 && response.status < 300;
      } catch {
        // Push registration is best-effort on top of store-and-forward — a failure must never
        // break bootstrap or sign-out.
        return false;
      }
    },
  };
}

/** Registers/revokes this device's push token (Req 6.2/6.4). */
export interface PushTokenClient {
  /**
   * Register `pushToken` for the device identified by `registrationId`, or REVOKE it by passing an
   * empty string (Req 6.4). Returns true on success; never throws.
   */
  setPushToken(registrationId: number, pushToken: string): Promise<boolean>;
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
  /** Read a peer's presence (online + coarse last-seen), or `null` on failure (Req 5.2). */
  getPresence(uid: string): Promise<PresenceResponse | null>;
  /** Set the signed-in user's presence opt-in (Req 5.1). Resolves true on success. */
  setPresence(enabled: boolean): Promise<boolean>;
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

    async getPresence(uid: string): Promise<PresenceResponse | null> {
      const token = getToken();
      if (token === null) {
        return null;
      }
      try {
        const response = await http.send({
          method: 'GET',
          url: `${apiBaseUrl}/api/directory/presence/${encodeURIComponent(uid)}`,
          headers: { Authorization: `Bearer ${token}` },
          timeoutMs: REQUEST_TIMEOUT_MS,
        });
        if (response.status === 200) {
          return JSON.parse(response.body) as PresenceResponse;
        }
      } catch {
        // Offline or backend down: presence is non-critical, so report unknown.
      }
      return null;
    },

    async setPresence(enabled: boolean): Promise<boolean> {
      const token = getToken();
      if (token === null) {
        return false;
      }
      try {
        const response = await http.send({
          method: 'POST',
          url: `${apiBaseUrl}/api/directory/presence`,
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled }),
          timeoutMs: REQUEST_TIMEOUT_MS,
        });
        return response.status === 204 || response.status === 200;
      } catch {
        return false;
      }
    },
  };
}
