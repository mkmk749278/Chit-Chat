/**
 * RegisterDeviceDto — runtime validation for `POST /api/devices/register`.
 *
 * Source of truth: design.md → "Data Models" → "DTOs and validation rules".
 * Implements the `RegisterDeviceDto` shape contract from `@chat-app/types`, adding the
 * class-validator decorators the global ValidationPipe enforces before the controller
 * (and therefore before any DB access) runs. A malformed body is rejected with HTTP 400
 * identifying the offending field, so no registration write is ever attempted on bad
 * input (Requirements 2.7, 2.8).
 *
 * Validation enforced here:
 * - `registrationId`: integer, >= 1.
 * - `identityKey`: base64 PUBLIC identity key.
 * - `signedPreKey`: a nested {@link SignedPreKeyDto} (recursively validated).
 * - `oneTimePreKeys`: an array of {@link OneTimePreKeyDto}, bounded 1..200; an empty or
 *   oversized array is rejected with HTTP 400.
 * - `deviceName`: optional string, <= 64 characters.
 *
 * All key material is PUBLIC base64 only. No field accepts a private key, and the global
 * pipe's `whitelist` + `forbidNonWhitelisted` strips/rejects any property not declared
 * here — there is no field path through which a private key could be supplied or stored
 * (Requirements 13.4, 13.7).
 */

import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBase64,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import type { RegisterDeviceDto as RegisterDeviceDtoShape } from '@chat-app/types';

import { OneTimePreKeyDto } from './one-time-prekey.dto';
import { SignedPreKeyDto } from './signed-prekey.dto';

export class RegisterDeviceDto implements RegisterDeviceDtoShape {
  /** libsignal registration id (>= 1). */
  @IsInt()
  @Min(1)
  registrationId!: number;

  /** Public identity key, base64. */
  @IsBase64()
  identityKey!: string;

  /** The device's active signed prekey (recursively validated). */
  @ValidateNested()
  @Type(() => SignedPreKeyDto)
  signedPreKey!: SignedPreKeyDto;

  /** Batch of one-time prekeys (bounded 1..200), each recursively validated. */
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => OneTimePreKeyDto)
  oneTimePreKeys!: OneTimePreKeyDto[];

  /** Optional human-readable device name (<= 64 chars). */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  deviceName?: string;

  /**
   * Optional E.164 phone number the user signed in with (discovery fallback). Validated to
   * E.164 so a malformed value is rejected; the server only uses it when the verified token
   * carries no phone claim, so it can never override a server-verified number.
   */
  @IsOptional()
  @Matches(/^\+[1-9]\d{6,14}$/, { message: 'phoneNumber must be a valid E.164 number' })
  phoneNumber?: string;
}
