/**
 * Vector-icon strategy (P3 visual system — design Component 9, Requirement 3.9).
 *
 * A single, typed `Icon` component maps the app's *semantic* affordance names (what the
 * icon means in the UI — `back`, `send`, `overflow`, …) to concrete glyphs from
 * `@expo/vector-icons`. `@expo/vector-icons` ships with the Expo SDK (no new native
 * module, no APK-signing impact), so adopting it carries none of the build risk of the
 * P1 native KDF module.
 *
 * Screens reference ONLY the semantic names below — they never import an icon family
 * directly. That keeps the glyph choices in one place and lets us re-skin the whole app
 * (swap families / glyphs) without touching screen code. Replacing the previous
 * emoji-as-icons keeps content emoji (reaction palette, the "message deleted" copy)
 * untouched — those are content, not affordances.
 */

import React from 'react';
import { MaterialIcons } from '@expo/vector-icons';

/** The semantic affordance names used across the app. */
export type IconName =
  | 'back' // header back chevron
  | 'more-vert' // ⋮ overflow menu
  | 'timer' // disappearing messages
  | 'shield' // safety number
  | 'verified' // identity verified / verify identity
  | 'hide' // hide chat (eye-off)
  | 'clear' // clear chat history (broom / delete-sweep)
  | 'trash' // delete chat entirely (trash can)
  | 'view-once' // view-once composer toggle (eye)
  | 'calls' // tab: calls
  | 'settings' // tab: settings
  | 'chats' // tab: chats / empty state
  | 'search' // search field
  | 'send' // composer send
  | 'compose' // new chat / FAB
  | 'status-sending' // message status: in flight (clock)
  | 'status-sent' // message status: sent (double check)
  | 'status-failed' // message status: failed
  | 'chevron-right'; // list-row affordance

/**
 * Map each semantic name to a `MaterialIcons` glyph. Using a single family keeps the
 * visual language consistent and the mapping fully type-checked against the family's
 * glyph union.
 */
const GLYPH: Record<IconName, React.ComponentProps<typeof MaterialIcons>['name']> = {
  back: 'arrow-back-ios-new',
  'more-vert': 'more-vert',
  timer: 'timer',
  shield: 'shield',
  verified: 'verified-user',
  hide: 'visibility-off',
  clear: 'delete-sweep',
  trash: 'delete-outline',
  'view-once': 'visibility',
  calls: 'call',
  settings: 'settings',
  chats: 'chat-bubble-outline',
  search: 'search',
  send: 'send',
  compose: 'edit',
  'status-sending': 'schedule',
  'status-sent': 'done-all',
  'status-failed': 'error-outline',
  'chevron-right': 'chevron-right',
};

export interface IconProps {
  /** Semantic affordance name. */
  name: IconName;
  /** Glyph size in logical px (default 22). */
  size?: number;
  /** Glyph color (default inherits a neutral; callers pass a theme color). */
  color?: string;
  /** Optional accessibility label; when omitted the icon is decorative. */
  accessibilityLabel?: string;
}

/**
 * Render a semantic affordance icon. Presentational and stateless: it only resolves the
 * semantic name to a glyph and forwards size/color. When no `accessibilityLabel` is given
 * the icon is treated as decorative (the surrounding pressable owns the label).
 */
export function Icon({ name, size = 22, color = '#5C6470', accessibilityLabel }: IconProps): React.JSX.Element {
  return (
    <MaterialIcons
      name={GLYPH[name]}
      size={size}
      color={color}
      accessible={accessibilityLabel !== undefined}
      accessibilityLabel={accessibilityLabel}
    />
  );
}
