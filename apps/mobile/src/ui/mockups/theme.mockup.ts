/**
 * MOCKUP — Refreshed design tokens (P3 visual system).
 *
 * This file mirrors the "Visual system refresh" section of the design
 * (`design.md` → Component 9): an explicit spacing scale, corner-radius scale,
 * and typography scale that the redesigned screens use for a calm, minimal,
 * modern look.
 *
 * IMPORTANT: this is DESIGN-ONLY code. It is isolated under `ui/mockups/` and
 * does NOT modify the production `theme.ts`. We deliberately REUSE the real
 * palette (`useTheme`, `avatarColor`, `initials`, `Theme`) from the production
 * theme so the mockups render with the exact same colors as the shipping app —
 * only the spacing/typography/radius scale is new here.
 */

import { useTheme, avatarColor, initials, type Theme } from '../theme';

// Re-export the production palette helpers so mockup screens import everything
// visual from a single module.
export { useTheme, avatarColor, initials };
export type { Theme };

/**
 * Spacing scale (logical px). Matches the design's
 * `spacing { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 }`.
 */
export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
} as const;

/**
 * Corner-radius scale. Matches the design's
 * `radius { sm: 8, md: 12, lg: 18, pill: 999 }`. `lg` is the message-bubble
 * radius; `pill` is for fully rounded chips/buttons.
 */
export const radius = {
  sm: 8,
  md: 12,
  lg: 18,
  pill: 999,
} as const;

/**
 * Typography scale. Matches the design's `type` block. `fontWeight` values are
 * cast `as const` so they satisfy React Native's `TextStyle['fontWeight']`.
 */
export const type = {
  title: { fontSize: 28, fontWeight: '800' as const, lineHeight: 34 },
  heading: { fontSize: 17, fontWeight: '700' as const, lineHeight: 22 },
  body: { fontSize: 15, fontWeight: '400' as const, lineHeight: 21 },
  meta: { fontSize: 12, fontWeight: '500' as const, lineHeight: 16 },
  caption: { fontSize: 11, fontWeight: '500' as const, lineHeight: 14 },
} as const;
