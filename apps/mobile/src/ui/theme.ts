/**
 * Lumin Chat visual identity (design/mockups). One palette object per scheme; every
 * screen pulls colors from `useTheme()` so the whole app follows the system
 * light/dark setting with no per-component branching.
 */

import { useColorScheme } from 'react-native';
import type { TextStyle } from 'react-native';

/**
 * Spacing scale (logical px) — P3 visual system (design Component 9, Requirement 3.10).
 * A single 4-based ramp every screen reaches for via `useTheme().spacing` (or the
 * standalone `spacing` export) so padding/margins are consistent and calm.
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
 * Corner-radius scale (Requirement 3.10). `lg` is the message-bubble radius; `pill`
 * is for fully rounded chips/avatars/FAB.
 */
export const radius = {
  sm: 8,
  md: 12,
  lg: 18,
  pill: 999,
} as const;

/**
 * Typography scale (Requirement 3.10). `fontWeight` values are cast `as const` so they
 * satisfy React Native's `TextStyle['fontWeight']` when spread into a style.
 */
export const type = {
  title: { fontSize: 28, fontWeight: '800' as const, lineHeight: 34 },
  heading: { fontSize: 17, fontWeight: '700' as const, lineHeight: 22 },
  body: { fontSize: 15, fontWeight: '400' as const, lineHeight: 21 },
  meta: { fontSize: 12, fontWeight: '500' as const, lineHeight: 16 },
  caption: { fontSize: 11, fontWeight: '500' as const, lineHeight: 14 },
} as const;

export type SpacingScale = typeof spacing;
export type RadiusScale = typeof radius;
export type TypographyScale = { readonly [K in keyof typeof type]: TextStyle };

export interface Theme {
  scheme: 'light' | 'dark';
  /** Screen background. */
  bg: string;
  /** Elevated surfaces: cards, headers, tab bar, composer. */
  surface: string;
  /** Subtle fill for inputs/chips. */
  field: string;
  /** Hairline dividers. */
  divider: string;
  /** Primary text. */
  text: string;
  /** Secondary text. */
  subtext: string;
  /** Tertiary/faint text. */
  faint: string;
  /** Brand (buttons, active tab, outgoing bubble). */
  brand: string;
  /** Lighter brand companion (gradient end / accents). */
  brandSoft: string;
  /** Text rendered on top of brand fills. */
  onBrand: string;
  /** Incoming bubble fill. */
  bubbleIn: string;
  /** Success/secure green. */
  secure: string;
  /** Destructive red. */
  danger: string;
  /** Destructive fill (sign-out button background). */
  dangerSoft: string;
  /** Encryption-notice (amber) text + fill. */
  noticeText: string;
  noticeFill: string;
  /** Brand-tinted strip fill (e.g. "chats are encrypted"). */
  brandFill: string;
  /** Spacing scale (Requirement 3.10) — consumed via `useTheme().spacing`. */
  spacing: SpacingScale;
  /** Corner-radius scale (Requirement 3.10) — consumed via `useTheme().radius`. */
  radius: RadiusScale;
  /** Typography scale (Requirement 3.10) — consumed via `useTheme().type`. */
  type: TypographyScale;
}

// UX directive palette: Near White / Charcoal / Slate / Deep Blue / soft accent.
// Calm and trustworthy — no neon, no hacker aesthetics, no aggressive gradients.
const light: Theme = {
  scheme: 'light',
  bg: '#FAFAF9',
  surface: '#FFFFFF',
  field: '#F1F2F4',
  divider: '#ECEDEF',
  text: '#1F2430',
  subtext: '#5C6470',
  faint: '#98A0AB',
  brand: '#2F5FE8',
  brandSoft: '#5B82EE',
  onBrand: '#FFFFFF',
  bubbleIn: '#FFFFFF',
  secure: '#2E7D55',
  danger: '#D4493E',
  dangerSoft: '#FBEDEC',
  noticeText: '#5C6470',
  noticeFill: '#F1F2F4',
  brandFill: '#EDF2FD',
  spacing,
  radius,
  type,
};

const dark: Theme = {
  scheme: 'dark',
  bg: '#15171C',
  surface: '#1B1E24',
  field: '#252932',
  divider: '#272B33',
  text: '#ECEEF1',
  subtext: '#9AA2AD',
  faint: '#646C78',
  brand: '#3D6BEA',
  brandSoft: '#7C9BF1',
  onBrand: '#FFFFFF',
  bubbleIn: '#23272F',
  secure: '#5FB98A',
  danger: '#E0706A',
  dangerSoft: '#2C1A19',
  noticeText: '#9AA2AD',
  noticeFill: '#21242B',
  brandFill: '#1D2433',
  spacing,
  radius,
  type,
};

/** Resolve the active theme from the system color scheme. */
export function useTheme(): Theme {
  return useColorScheme() === 'dark' ? dark : light;
}

/** Deterministic avatar color for a peer (stable across renders/sessions). Muted, calm tones. */
const AVATAR_COLORS = ['#4A7D6D', '#B07A4F', '#4A6FA8', '#A86487', '#6E6AA8', '#508487'];
export function avatarColor(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) {
    hash = (hash * 31 + seed.charCodeAt(i)) | 0;
  }
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

/** Initials for an avatar chip (first letters of up to two words). */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter((p) => p.length > 0);
  if (parts.length === 0) {
    return '?';
  }
  const first = parts[0][0] ?? '?';
  const second = parts.length > 1 ? (parts[1][0] ?? '') : '';
  return (first + second).toUpperCase();
}
