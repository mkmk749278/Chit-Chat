/**
 * BlobsController — ciphertext-only attachment upload/download (Phase 2, Req 7.1).
 *
 * `POST /api/blobs` stores opaque, client-encrypted ciphertext and returns its handle;
 * `GET /api/blobs/:id` returns it back (or 404 once expired). Both are authenticated; upload is
 * per-uid rate-limited. The server holds only ciphertext under a TTL and never sees the key.
 */

import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  Logger,
  NotFoundException,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import type { AuthContext, DownloadBlobResponse, UploadBlobResponse } from '@chat-app/types';

import { Auth, FirebaseAuthGuard } from '../auth';
import { RateLimiterService } from '../redis';
import {
  BLOB_UPLOAD_RATE_LIMIT,
  BLOB_UPLOAD_RATE_LIMIT_SCOPE,
  BLOB_UPLOAD_RATE_WINDOW_SECONDS,
} from './blobs.constants';
import { BlobService } from './blobs.service';
import { UploadBlobDto } from './dto';

@Controller('api/blobs')
export class BlobsController {
  private readonly logger = new Logger(BlobsController.name);

  constructor(
    private readonly blobs: BlobService,
    private readonly rateLimiter: RateLimiterService,
  ) {}

  /**
   * Upload an attachment's ciphertext (base64). Rate-limited per uid (fails open on limiter
   * error). Returns the `{ blobId }` to place in the E2E `attachment` payload.
   *
   * @throws HttpException 429 when the per-uid upload limit is exceeded.
   * @throws PayloadTooLargeException (413) when the ciphertext exceeds the size bound (from the service).
   */
  @Post()
  @UseGuards(FirebaseAuthGuard)
  @HttpCode(HttpStatus.CREATED)
  async upload(@Auth() auth: AuthContext, @Body() dto: UploadBlobDto): Promise<UploadBlobResponse> {
    let allowed = true;
    try {
      const result = await this.rateLimiter.hit(
        `${BLOB_UPLOAD_RATE_LIMIT_SCOPE}:${auth.uid}`,
        BLOB_UPLOAD_RATE_LIMIT,
        BLOB_UPLOAD_RATE_WINDOW_SECONDS,
      );
      allowed = result.allowed;
    } catch {
      this.logger.warn('Blob-upload rate-limit check failed; allowing request');
    }
    if (!allowed) {
      throw new HttpException('Rate limit exceeded', HttpStatus.TOO_MANY_REQUESTS);
    }

    const blobId = await this.blobs.store(dto.ciphertext);
    return { blobId };
  }

  /**
   * Download an attachment's ciphertext by id. Authenticated; the body is opaque ciphertext the
   * caller decrypts locally with the key from the E2E payload.
   *
   * @throws NotFoundException (404) when the blob is unknown or has expired (Req 7.4).
   */
  @Get(':id')
  @UseGuards(FirebaseAuthGuard)
  async download(@Param('id') id: string): Promise<DownloadBlobResponse> {
    const ciphertext = await this.blobs.fetch(id);
    if (ciphertext === null) {
      throw new NotFoundException('Attachment not found or expired');
    }
    return { ciphertext };
  }
}
