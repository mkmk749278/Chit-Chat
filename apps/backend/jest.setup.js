/**
 * Jest global setup: provide placeholder values for the backend's required
 * environment variables.
 *
 * Several modules pull in `config/index.ts`, which calls `ConfigModule.forRoot`
 * with the fail-fast `validateEnv` hook at module-load time. The unit suites
 * import services transitively through those barrels but construct them directly
 * with stubbed dependencies — they never use the real config values. Without these
 * placeholders, merely importing a service would throw `MissingEnvironmentError`
 * and crash the test worker.
 *
 * Values mirror the required set in `src/config/env.validation.ts` and use
 * realistic shapes so anything that later parses them (e.g. a URL) stays valid.
 * Existing real values (e.g. in CI) are never overwritten.
 */
const TEST_ENV = {
  DATABASE_URL: 'postgres://test:test@localhost:5432/test',
  PGBOUNCER_URL: 'postgres://test:test@localhost:6432/test',
  REDIS_URL: 'redis://localhost:6379',
  FIREBASE_PROJECT_ID: 'test-project',
  FIREBASE_CLIENT_EMAIL: 'test@test-project.iam.gserviceaccount.com',
  FIREBASE_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\\ntest\\n-----END PRIVATE KEY-----\\n',
  SENTRY_DSN_BACKEND: 'https://test@sentry.invalid/1',
  JWT_SECRET: 'test-jwt-secret',
  ENCRYPTION_KEY: 'test-encryption-key-0000000000000000',
};

for (const [name, value] of Object.entries(TEST_ENV)) {
  if (process.env[name] === undefined || process.env[name] === '') {
    process.env[name] = value;
  }
}
