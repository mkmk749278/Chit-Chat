import { HttpStatus } from '@nestjs/common';
import type { Response } from 'express';

import { HealthController } from './health.controller';
import type { HealthService } from './health.service';
import type { HealthReport } from './health.types';

/**
 * Unit tests for {@link HealthController} (task 8.1, Requirement 11). They confirm the HTTP status
 * mirrors the report: `200` for `ok`, `503` for `degraded` so the deploy pipeline fails fast
 * (Requirements 11.1, 11.4), and that the report body is returned unchanged for serialization.
 */

function buildResponse(): Response & { status: jest.Mock } {
  const res = { status: jest.fn().mockReturnThis() };
  return res as unknown as Response & { status: jest.Mock };
}

function buildController(report: HealthReport): { controller: HealthController } {
  const service = { check: jest.fn().mockResolvedValue(report) } as unknown as HealthService;
  return { controller: new HealthController(service) };
}

describe('HealthController.check', () => {
  it('returns the report with HTTP 200 when status is ok', async () => {
    const report: HealthReport = {
      status: 'ok',
      checks: { postgres: 'up', redis: 'up' },
      uptimeSeconds: 5,
      version: '1.2.3',
    };
    const { controller } = buildController(report);
    const res = buildResponse();

    const result = await controller.check(res);

    expect(res.status).toHaveBeenCalledWith(HttpStatus.OK);
    expect(result).toEqual(report);
  });

  it('returns the report with HTTP 503 when status is degraded', async () => {
    const report: HealthReport = {
      status: 'degraded',
      checks: { postgres: 'down', redis: 'up' },
      uptimeSeconds: 5,
      version: '1.2.3',
    };
    const { controller } = buildController(report);
    const res = buildResponse();

    const result = await controller.check(res);

    expect(res.status).toHaveBeenCalledWith(HttpStatus.SERVICE_UNAVAILABLE);
    expect(result).toEqual(report);
  });
});
