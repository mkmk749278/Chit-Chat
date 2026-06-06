/**
 * @chat-app/types — shared TypeScript types for the Phase 0 monorepo.
 *
 * Re-exports the auth/identity types, the device-registration DTO shapes, and the
 * entity-as-type definitions so `apps/backend`, `apps/web`, and `apps/mobile` can
 * import them from the in-repo workspace package (`@chat-app/types`).
 */

export * from './auth';
export * from './dtos';
export * from './entities';
export * from './prekeys';
export * from './status';
export * from './messaging';
