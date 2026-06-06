/**
 * Jest configuration for the NestJS backend unit tests.
 *
 * The backend's `*.test.ts` suites exercise services, controllers, and pure
 * utilities directly (without booting Nest), so a lightweight ts-jest setup over
 * the project tsconfig is sufficient. The project tsconfig already enables the
 * decorator metadata the Nest providers rely on, so ts-jest compiles them the
 * same way the build does.
 */
/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: 'src',
  testMatch: ['**/*.test.ts'],
  // Inject placeholder env before any module (and its load-time config validation) loads.
  setupFiles: ['<rootDir>/../jest.setup.js'],
  // Compile tests with the project tsconfig (decorators, strict, ES2022).
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/../tsconfig.json' }],
  },
  clearMocks: true,
};
