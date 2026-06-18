/**
 * UploadBlobDto — runtime validation for `POST /api/blobs` (Req 7.1).
 *
 * Implements `UploadBlobRequest`. The body is opaque base64 ciphertext; the global ValidationPipe
 * bounds its length cheaply before the handler runs, and {@link BlobService.store} enforces the
 * exact byte bound. The server never decodes the bytes.
 */

import { IsString, MaxLength, MinLength } from 'class-validator';
import type { UploadBlobRequest } from '@chat-app/types';

import { MAX_BLOB_BYTES } from '../blobs.constants';

/** base64 is ~4/3 the byte size; cap the string a little above the byte bound (+ padding margin). */
const MAX_CIPHERTEXT_CHARS = Math.ceil(MAX_BLOB_BYTES / 3) * 4 + 16;

export class UploadBlobDto implements UploadBlobRequest {
  @IsString()
  @MinLength(1)
  @MaxLength(MAX_CIPHERTEXT_CHARS)
  ciphertext!: string;
}
