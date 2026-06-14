/**
 * SetProfileDto — runtime validation for `POST /api/directory/profile`.
 *
 * Implements the `SetProfileRequest` shape from `@chat-app/types`. The display name is a
 * human-readable label shown to peers; bounded 1–32 characters and trimmed.
 */

import { Transform } from 'class-transformer';
import { IsString, MaxLength, MinLength } from 'class-validator';
import type { SetProfileRequest } from '@chat-app/types';

export class SetProfileDto implements SetProfileRequest {
  @IsString()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @MinLength(1)
  @MaxLength(32)
  displayName!: string;
}
