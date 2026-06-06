/**
 * SignedPreKeyDto — runtime validation for the device's active signed prekey.
 *
 * Source of truth: design.md → "Data Models" → "DTOs and validation rules".
 * Implements the `SignedPreKeyDto` shape contract from `@chat-app/types`, adding the
 * class-validator decorators the global ValidationPipe enforces before any controller
 * (and therefore any DB access) runs (Requirements 2.7, 2.8).
 *
 * Every key field is PUBLIC base64 material only. There is deliberately no field that
 * accepts a private key, and the global pipe's `forbidNonWhitelisted` rejects any
 * unknown property (such as a smuggled private-key field) with HTTP 400
 * (Requirements 13.4, 13.7).
 */

import { IsBase64, IsInt, Min } from 'class-validator';
import type { SignedPreKeyDto as SignedPreKeyDtoShape } from '@chat-app/types';

export class SignedPreKeyDto implements SignedPreKeyDtoShape {
  /** libsignal signed prekey id (non-negative integer). */
  @IsInt()
  @Min(0)
  keyId!: number;

  /** Public signed prekey, base64. */
  @IsBase64()
  publicKey!: string;

  /** Signature over `publicKey` by the identity key, base64. */
  @IsBase64()
  signature!: string;
}
