/**
 * Public surface of the backend BlobsModule (Phase 2, Requirement 7.1).
 */

export { BlobsModule } from './blobs.module';
export { BlobService } from './blobs.service';
export { BlobsController } from './blobs.controller';
export { UploadBlobDto } from './dto';
export {
  MAX_BLOB_BYTES,
  BLOB_TTL_SECONDS,
} from './blobs.constants';
