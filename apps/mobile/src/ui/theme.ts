/**
 * Lumin Chat visual identity (design/mockups). One palette object per scheme; every
 * screen pulls colors from `useTheme()` so the whole app follows the system
 * light/dark setting with no per-component branching.
 */

import { useColorScheme } from 'react-native';

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
}

const light: Theme = {
  scheme: 'light',
  bg: '#FBFBFE',
  surface: '#FFFFFF',
  field: '#F2F2F7',
  divider: '#EFEFF4',
  text: '#14141B',
  subtext: '#6B7280',
  faint: '#9AA0AC',
  brand: '#6D5EF7',
  brandSoft: '#9B8CFA',
  onBrand: '#FFFFFF',
  bubbleIn: '#FFFFFF',
  secure: '#177A3B',
  danger: '#E0463B',
  dangerSoft: '#FDECEC',
  noticeText: '#8A6D1A',
  noticeFill: '#FBF3D9',
  brandFill: '#F3F1FE',
};

const dark: Theme = {
  scheme: 'dark',
  bg: '#0C0C12',
  surface: '#101019',
  field: '#1B1B26',
  divider: '#1E1E2A',
  text: '#F2F2F7',
  subtext: '#9CA3AF',
  faint: '#6B7280',
  brand: '#7C6CFF',
  brandSoft: '#A99BFF',
  onBrand: '#16131F',
  bubbleIn: '#1C1C28',
  secure: '#46D38A',
  danger: '#F87171',
  dangerSoft: '#2A1414',
  noticeText: '#E5C16B',
  noticeFill: '#241F12',
  brandFill: '#191527',
};

/** Resolve the active theme from the system color scheme. */
export function useTheme(): Theme {
  return useColorScheme() === 'dark' ? dark : light;
}

/** Deterministic avatar color for a peer (stable across renders/sessions). */
const AVATAR_COLORS = ['#10B981', '#F97316', '#3B82F6', '#EC4899', '#8B5CF6', '#14B8A6'];
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
