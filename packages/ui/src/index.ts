/**
 * `@chat-app/ui` — shared UI components (shared TypeScript).
 *
 * Phase 0 placeholder. This package exists so the npm workspace resolves
 * `@chat-app/ui` to the in-repo directory and so a workspace-wide build completes
 * cleanly (Requirements 1.1, 1.2, 1.5). The real shared component library is added
 * with the client UI work in later phases.
 */

/** Canonical package name; lets consumers assert the in-repo package is wired. */
export const UI_PACKAGE_NAME = '@chat-app/ui' as const;

/** Placeholder marker indicating the shared UI package is wired but not yet populated. */
export const placeholder = true as const;
