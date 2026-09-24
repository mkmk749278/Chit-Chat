import { HttpException, PayloadTooLargeException } from '@nestjs/common';

import { BlobService } from './blobs.service';
import { BLOB_DAILY_BYTES_PER_USER, BLOB_TTL_SECONDS, MAX_BLOB_BYTES } from './blobs.constants';

/**
 * Unit tests for {@link BlobService} (Req 7.1/7.4). Exercised with a stub Redis client, asserting
 * the ciphertext is stored verbatim under a TTL, fetched back, missing/expired blobs resolve to
 * null, and oversize uploads are rejected before any write.
 */

function build(getValue: string | null = null, quotaAdmits: number | Error = 1): {
  service: BlobService;
  set: jest.Mock;
  get: jest.Mock;
  evalScript: jest.Mock;
} {
  const set = jest.fn().mockResolvedValue('OK');
  const get = jest.fn().mockResolvedValue(getValue);
  const evalScript =
    quotaAdmits instanceof Error
      ? jest.fn().mockRejectedValue(quotaAdmits)
      : jest.fn().mockResolvedValue(quotaAdmits);
  const redis = { set, get, eval: evalScript } as unknown as ConstructorParameters<typeof BlobService>[0];
  return { service: new BlobService(redis), set, get, evalScript };
}

describe('BlobService.store', () => {
  it('stores the ciphertext verbatim under a TTL and returns a handle', async () => {
    const { service, set } = build();
    const ciphertext = Buffer.from('opaque-ciphertext').toString('base64');

    const blobId = await service.store(ciphertext);

    expect(typeof blobId).toBe('string');
    expect(blobId.length).toBeGreaterThan(0);
    expect(set).toHaveBeenCalledTimes(1);
    const [key, value, ex, ttl] = set.mock.calls[0] as [string, string, string, number];
    expect(key).toBe(`blob:${blobId}`);
    expect(value).toBe(ciphertext); // never decoded/transformed
    expect(ex).toBe('EX');
    expect(ttl).toBe(BLOB_TTL_SECONDS);
  });

  it('rejects an oversize upload with 413 before writing', async () => {
    const { service, set } = build();
    // base64 length that decodes to > MAX_BLOB_BYTES.
    const tooBig = 'A'.repeat(Math.ceil((MAX_BLOB_BYTES + 1) * 4) / 3 + 8);
    await expect(service.store(tooBig)).rejects.toBeInstanceOf(PayloadTooLargeException);
    expect(set).not.toHaveBeenCalled();
  });
});

describe('BlobService.fetch', () => {
  it('returns the stored ciphertext for a known id', async () => {
    const { service, get } = build('stored-ciphertext');
    expect(await service.fetch('abc')).toBe('stored-ciphertext');
    expect(get).toHaveBeenCalledWith('blob:abc');
  });

  it('returns null for an unknown or expired id', async () => {
    const { service } = build(null);
    expect(await service.fetch('gone')).toBeNull();
  });
});

describe('BlobService.store — per-user daily byte quota', () => {
  it('charges the upload to the uploader and stores it when within quota', async () => {
    const { service, set, evalScript } = build(null, 1);
    const ciphertext = Buffer.alloc(3000).toString('base64');

    await service.store(ciphertext, 'alice');

    const [, numKeys, key, bytes, limit] = evalScript.mock.calls[0] as unknown[];
    expect(numKeys).toBe(1);
    expect(key).toBe('blob-quota:alice');
    expect(bytes).toBe(3000);
    expect(limit).toBe(BLOB_DAILY_BYTES_PER_USER);
    expect(set).toHaveBeenCalledTimes(1);
  });

  it('rejects with 429 and writes nothing once the quota is exhausted', async () => {
    const { service, set } = build(null, 0);
    await expect(service.store(Buffer.from('x').toString('base64'), 'alice')).rejects.toBeInstanceOf(
      HttpException,
    );
    expect(set).not.toHaveBeenCalled();
  });

  it('fails open when the quota counter is unavailable', async () => {
    const { service, set } = build(null, new Error('redis down'));
    await service.store(Buffer.from('x').toString('base64'), 'alice');
    expect(set).toHaveBeenCalledTimes(1);
  });
});
