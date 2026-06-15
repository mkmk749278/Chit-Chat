/**
 * AddOneTimePreKeysDto — runtime validation for `POST /api/devices/prekeys`.
 *
 * Implements the `AddOneTimePreKeysRequest` shape from `@chat-app/types`. Replenishes a
 * registered device's one-time prekeys by APPENDING a new batch (registration replaces the
 * whole bundle; this only adds). The global ValidationPipe enforces these rules before any DB
 * access; all key material is PUBLIC base64 only (Requirements 2.7, 2.8, 13.4).
 */

import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsInt, Min, ValidateNested } from 'class-validator';
import type { AddOneTimePreKeysRequest } from '@chat-app/types';

import { OneTimePreKeyDto } from './one-time-prekey.dto';

export class AddOneTimePreKeysDto implements AddOneTimePreKeysRequest {
  /** libsignal registration id of the device to append to (>= 1). */
  @IsInt()
  @Min(1)
  registrationId!: number;

  /** New one-time prekeys to append (bounded 1..200), each recursively validated. */
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => OneTimePreKeyDto)
  oneTimePreKeys!: OneTimePreKeyDto[];
}
