/**
 * HealthController — the unauthenticated `GET /health` liveness/readiness endpoint (design
 * Component 7, Requirement 11).
 *
 * Used by the deploy pipeline (`curl https://api.yourdomain.com/health`, §14.2) and container
 * orchestration. It carries no guard, so it serves identically whether or not credentials are
 * supplied (Requirement 11.2), and its body — produced by {@link HealthService} — exposes only the
 * overall status and per-dependency reachability, never user data, secrets, or connection strings
 * (Requirement 11.3).
 *
 * The HTTP status mirrors the report: `200` when both dependencies are reachable (`ok`), otherwise
 * `503` (`degraded`) so the deploy pipeline fails fast (Requirements 11.1, 11.4). The status is set
 * via a passthrough response so Nest still serializes the returned {@link HealthReport} as JSON.
 */

import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import type { Response } from 'express';

import { HealthService } from './health.service';
import type { HealthReport } from './health.types';

@Controller()
export class HealthController {
  constructor(private readonly health: HealthService) {}

  @Get('health')
  async check(@Res({ passthrough: true }) res: Response): Promise<HealthReport> {
    const report = await this.health.check();
    res.status(report.status === 'ok' ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE);
    return report;
  }
}
