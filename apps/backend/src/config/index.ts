/**
 * Public surface of the backend ConfigModule.
 */

export { ConfigModule } from './config.module';
export { AppConfigService } from './app-config.service';
export {
  validateEnv,
  REQUIRED_ENV_VARS,
  DEFAULT_HTTP_PORT,
  DEFAULT_WS_PORT,
  MissingEnvironmentError,
  InvalidEnvironmentError,
} from './env.validation';
export type { AppConfig, RequiredEnvVar } from './env.validation';
