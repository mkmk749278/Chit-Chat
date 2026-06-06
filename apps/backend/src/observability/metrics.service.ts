import { Injectable } from '@nestjs/common';
import {
  Counter,
  Histogram,
  Registry,
  collectDefaultMetrics,
} from 'prom-client';

import {
  HTTP_METRIC_LABELS,
  HTTP_REQUESTS_TOTAL,
  HTTP_REQUEST_DURATION_BUCKETS,
  HTTP_REQUEST_DURATION_SECONDS,
} from './metrics.constants';

/** Label key type shared by the HTTP counter and histogram. */
type HttpMetricLabel = (typeof HTTP_METRIC_LABELS)[number];

/**
 * MetricsService — owns the Prometheus registry and the backend's HTTP metrics
 * (Requirement 12.3).
 *
 * On construction it:
 *   - creates an *isolated* registry (not the global default) so the service can
 *     be instantiated repeatedly in tests without "metric already registered"
 *     collisions;
 *   - registers the prom-client default process/runtime metrics (CPU, heap,
 *     event-loop lag, …) into that registry;
 *   - declares the two custom HTTP metrics required by §12.3: a request counter
 *     and a latency histogram, both labelled by method / route / status.
 *
 * The {@link MetricsController} renders {@link snapshot} in the Prometheus text
 * exposition format, and {@link MetricsMiddleware} calls {@link observeRequest}
 * once per completed request.
 */
@Injectable()
export class MetricsService {
  private readonly registry: Registry;
  private readonly httpRequestsTotal: Counter<HttpMetricLabel>;
  private readonly httpRequestDuration: Histogram<HttpMetricLabel>;

  constructor() {
    this.registry = new Registry();
    collectDefaultMetrics({ register: this.registry });

    this.httpRequestsTotal = new Counter({
      name: HTTP_REQUESTS_TOTAL,
      help: 'Total number of completed HTTP requests, labelled by method, route, and status.',
      labelNames: HTTP_METRIC_LABELS as unknown as HttpMetricLabel[],
      registers: [this.registry],
    });

    this.httpRequestDuration = new Histogram({
      name: HTTP_REQUEST_DURATION_SECONDS,
      help: 'HTTP request latency in seconds, labelled by method, route, and status.',
      labelNames: HTTP_METRIC_LABELS as unknown as HttpMetricLabel[],
      buckets: [...HTTP_REQUEST_DURATION_BUCKETS],
      registers: [this.registry],
    });
  }

  /**
   * Record a single completed HTTP request: increment the request counter and
   * observe its latency. Called from {@link MetricsMiddleware} on `res.finish`.
   *
   * @param method - HTTP method label (already normalised).
   * @param route - matched route / path label (already normalised).
   * @param status - HTTP status code label (already normalised).
   * @param durationSeconds - wall-clock request duration in seconds.
   */
  observeRequest(
    method: string,
    route: string,
    status: string,
    durationSeconds: number,
  ): void {
    const labels = { method, route, status };
    this.httpRequestsTotal.inc(labels);
    this.httpRequestDuration.observe(labels, durationSeconds);
  }

  /** Render every registered metric in the Prometheus text exposition format. */
  snapshot(): Promise<string> {
    return this.registry.metrics();
  }

  /** The Content-Type the `/metrics` response must advertise. */
  get contentType(): string {
    return this.registry.contentType;
  }
}
