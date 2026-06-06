import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';

import { AppConfigService } from '../config';

import { extractClientIp, type IpBearingRequest } from './http-metrics.util';
import { isIpAllowed, parseMonitoringCidrs } from './monitoring-network.util';

/**
 * MonitoringNetworkGuard — restricts an endpoint to the monitoring network
 * (Requirements 12.7, 13.6).
 *
 * Applied to the Prometheus `/metrics` route. It resolves the request's *real*
 * transport source address (never the spoofable `X-Forwarded-For` header) and
 * allows the request only when that address falls inside the configured
 * monitoring CIDR allowlist. Any request originating outside the monitoring
 * network is rejected with `403 Forbidden` and reaches no handler, so no metrics
 * data is ever returned to it.
 *
 * The allowlist is resolved once from `MONITORING_CIDRS` (falling back to the
 * private/loopback defaults), since configuration is immutable after startup.
 */
@Injectable()
export class MonitoringNetworkGuard implements CanActivate {
  private readonly allowlist: string[];

  constructor(config: AppConfigService) {
    this.allowlist = parseMonitoringCidrs(config.monitoringCidrs);
  }

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<IpBearingRequest>();
    const sourceIp = extractClientIp(request);

    if (!isIpAllowed(sourceIp, this.allowlist)) {
      // Deny without leaking why; the handler never runs, so no metrics are
      // exposed to a caller outside the monitoring network.
      throw new ForbiddenException();
    }
    return true;
  }
}
