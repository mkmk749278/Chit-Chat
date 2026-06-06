import { Controller, Get, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';

import { MetricsService } from './metrics.service';
import { MonitoringNetworkGuard } from './monitoring-network.guard';

/**
 * MetricsController — the Prometheus scrape endpoint (Requirements 12.3, 12.7,
 * 13.6).
 *
 * `GET /metrics` returns every registered metric (prom-client defaults plus the
 * custom HTTP request count / latency metrics) in the Prometheus text exposition
 * format. The route is intentionally unauthenticated (it carries no user data)
 * but is network-gated by {@link MonitoringNetworkGuard}: requests from outside
 * the monitoring network are rejected before this handler runs, so they receive
 * no metrics data.
 */
@Controller()
export class MetricsController {
  constructor(private readonly metrics: MetricsService) {}

  @Get('metrics')
  @UseGuards(MonitoringNetworkGuard)
  async scrape(@Res() res: Response): Promise<void> {
    const body = await this.metrics.snapshot();
    res.setHeader('Content-Type', this.metrics.contentType);
    res.send(body);
  }
}
