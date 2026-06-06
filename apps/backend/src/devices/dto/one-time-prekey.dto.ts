/**
 * OneTimePreKeyDto — runtime validation for a single one-time prekey.
 *
 * Source of truth: design.md → "Data Models" → "DTOs and validation rules".
 * Implements the `OneTimePreKeyDto` shape contract from `@chat-app/types`, adding the
 * class-validator decorators enforced by the global ValidationPipe before any DB
 * access (Requirements 2.7, 2.8).
 *
 * `publicKey` is PUBLIC base64 material only — there is no field that accepts a
 * private key, and `forbidNonWhitelisted` rejects any unknown property with HTTP 400
 * (Requirements 13.4, 13.7).
 */

import { IsBase64, IsInt, Min } from 'class-validator';
import type { OneTimePreKeyDto as OneTimePreKeyDtoShape } from '@chat-app/types';

export class OneTimePreKeyDto implements OneTimePreKeyDtoShape {
  /** libsignal one-time prekey id (non-negative integer). */
  @IsInt()
  @Min(0)
  keyId!: number;

  /** Public one-time prekey, base64. */
  @IsBase64()
  publicKey!: string;
}
