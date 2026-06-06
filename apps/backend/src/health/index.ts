/**
 * Public surface of the HealthModule (unauthenticated `/health` endpoint, Requirement 11).
 */
export { HealthModule } from './health.module';
export { HealthController } from './health.controller';
export { HealthService } from './health.service';
export {
  HEALTH_PING_TIMEOUT_MS,
  HEALTH_RESPONSE_BUDGET_MS,
} from './health.constants';
export type {
  DependencyStatus,
  HealthStatus,
  HealthReport,
} from './health.types';
