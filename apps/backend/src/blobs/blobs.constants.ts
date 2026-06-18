/**
 * Blob-store tuning constants (Phase 2, Requirement 7).
 */

/**
 * Maximum stored ciphertext size in bytes (~8 MiB). Attachments are bounded so a single upload
 * cannot exhaust the store; the client enforces a matching bound before encrypting (Req 7.3).
 * AES-GCM ciphertext is ~the plaintext size + a 16-byte tag, so this caps plaintext at ~8 MiB.
 */
export const MAX_BLOB_BYTES = 8 * 1024 * 1024;

/**
 * How long an uploaded ciphertext blob survives before it is auto-deleted (Req 7.4). Generous
 * enough to cover store-and-forward delivery to an offline recipient, then reclaimed so
 * undelivered ciphertext does not persist indefinitely. Matches the offline-queue TTL (7 days).
 */
export const BLOB_TTL_SECONDS = 7 * 24 * 60 * 60;

/** Per-uid upload rate-limit window + cap, to blunt abuse of the unauthenticated-content store. */
export const BLOB_UPLOAD_RATE_LIMIT = 60;
export const BLOB_UPLOAD_RATE_WINDOW_SECONDS = 60;
export const BLOB_UPLOAD_RATE_LIMIT_SCOPE = 'blob-upload';
