/**
 * BlobService — ciphertext-only attachment blob store (Phase 2, Requirement 7.1/7.4).
 *
 * Holds opaque, client-encrypted attachment ciphertext keyed by a server-issued id, under a TTL
 * so undelivered ciphertext does not persist indefinitely (Req 7.4). The server NEVER holds the
 * per-attachment key (it rides in the E2E `attachment` payload, Req 7.2) and NEVER decodes the
 * bytes — it stores and returns the base64 ciphertext verbatim (Req 7.1, invariant C1).
 *
 * Backed by Redis with an `EX` expiry (one moving part, atomic TTL). Multi-MB base64 in Redis is
 * memory-heavy; swapping this for object storage (S3/GCS) behind the same interface is the
 * documented production follow-up — callers and the wire contract do not change.
 */

import { Inject, Injectable, PayloadTooLargeException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type Redis from 'ioredis';

import { REDIS_COMMAND_CLIENT } from '../redis';
import { BLOB_TTL_SECONDS, MAX_BLOB_BYTES } from './blobs.constants';

/** Redis key prefix for a stored ciphertext blob: `blob:{id}`. */
const BLOB_KEY_PREFIX = 'blob:';

@Injectable()
export class BlobService {
  constructor(@Inject(REDIS_COMMAND_CLIENT) private readonly redis: Redis) {}

  /**
   * Store opaque ciphertext (base64) and return its handle. Rejects oversize uploads with HTTP
   * 413 before any write (Req 7.3 size bound). The TTL is applied atomically with the write so an
   * undelivered blob always expires (Req 7.4). The bytes are never decoded (Req 7.1).
   *
   * @returns the server-issued `blobId` to place in the E2E `attachment` payload.
   * @throws PayloadTooLargeException (413) when the decoded ciphertext exceeds {@link MAX_BLOB_BYTES}.
   */
  async store(ciphertextBase64: string): Promise<string> {
    // base64 decodes to ~3/4 of its length; bound the byte size, not the string length.
    const approxBytes = Math.floor((ciphertextBase64.length * 3) / 4);
    if (approxBytes > MAX_BLOB_BYTES) {
      throw new PayloadTooLargeException('Attachment exceeds the maximum size');
    }
    const blobId = randomUUID();
    await this.redis.set(BlobService.blobKey(blobId), ciphertextBase64, 'EX', BLOB_TTL_SECONDS);
    return blobId;
  }

  /** Fetch stored ciphertext (base64) by id, or `null` when it is unknown or has expired. */
  async fetch(blobId: string): Promise<string | null> {
    return this.redis.get(BlobService.blobKey(blobId));
  }

  /** Builds the store key `blob:{id}`. */
  private static blobKey(id: string): string {
    return `${BLOB_KEY_PREFIX}${id}`;
  }
}
