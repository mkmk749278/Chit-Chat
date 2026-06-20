import { defineConfig } from 'vitest/config';

/**
 * Vitest configuration for the web app's unit tests.
 *
 * The web `KeyStore` and its session-end wipe (Property 19) need a DOM (`window`,
 * `addEventListener`, `pagehide`/`beforeunload`), so tests run in the `jsdom`
 * environment. Only `*.test.ts(x)` under `app/` are collected.
 */
export default defineConfig({
  test: {
    environment: 'jsdom',
    include: ['app/**/*.test.{ts,tsx}'],
  },
  // Component tests (.tsx) render real components whose JSX relies on React's automatic runtime
  // (the same runtime Next.js uses); classic-runtime transforms would need `React` in scope.
  esbuild: {
    jsx: 'automatic',
  },
});
