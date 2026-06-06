import { Injectable, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

import {
  resolveMethodLabel,
  resolveRouteLabel,
  resolveStatusLabel,
} from './http-metrics.util';
import { MetricsService } from './metrics.service';

/** Nanoseconds per second, used to convert `process.hrtime.bigint()` deltas. */
const NS_PER_SECOND = 1_000_000_000;

/**
 * MetricsMiddleware — records one HTTP request count + latency observation per
 * completed request (Requirement 12.3).
 *
 * It starts a high-resolution timer when the request arrives and hooks the
 * response `finish` event. `finish` fires once the response has been fully
 * flushed — after routing has resolved — so the matched route pattern and final
 * status code are available, and every request is counted exactly once including
 * error responses and 404s. The route label is the matched pattern where
 * possible to keep metric cardinality bounded.
 */
@Injectable()
export class MetricsMiddleware implements NestMiddleware {
  constructor(private readonly metrics: MetricsService) {}

  use(req: Request, res: Response, next: NextFunction): void {
    const start = process.hrtime.bigint();

    res.once('finish', () => {
      const durationSeconds = Number(process.hrtime.bigint() - start) / NS_PER_SECOND;
      this.metrics.observeRequest(
        resolveMethodLabel(req.method),
        resolveRouteLabel(req),
        resolveStatusLabel(res.statusCode),
        durationSeconds,
      );
    });

    next();
  }
}
