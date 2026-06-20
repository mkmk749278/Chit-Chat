/**
 * Conversation `⋮` overflow menu (mobile) — task 17.2 UI bug fix.
 *
 * Previously this menu was rendered as a pair of absolutely-positioned siblings (`overflowScrim`
 * + `overflowMenu`) INSIDE the conversation header `View`. Because those siblings lived in the same
 * stacking context as the `FlatList` of message bubbles, the menu drew *behind* the message rows
 * (its `zIndex`/`elevation` could not lift it above a later sibling subtree on all platforms).
 *
 * The fix re-renders the menu through a top-level React Native `Modal` portal — the SAME
 * modal-portal approach used by `SheetModal` in `action-sheet.tsx`. A `Modal` mounts its children
 * at the root overlay layer (above the entire app view tree), so the menu now draws unconditionally
 * ABOVE the message list regardless of z-order/elevation quirks.
 *
 * This component is purely presentational: it routes a chosen action key back through the existing
 * `onSelect` callback (wired to the existing conversation action sheets) — no conversation/crypto
 * state is owned here. It is INDEPENDENT of shadow-chat correctness (no shadow/thread logic).
 */

import React from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';

import { CLEAR_CHAT_ACTION, CONVERSATION_ACTIONS, type ConversationActionKey } from './conversation-actions';
import { Icon, type IconName } from './icons';
import type { Theme } from './theme';

/** Screen-space anchor (from `measureInWindow`) used to position the dropdown under the ⋮ button. */
export interface OverflowMenuAnchor {
  /** Distance from the top of the screen to the top of the menu. */
  top: number;
  /** Distance from the right edge of the screen to the right edge of the menu. */
  right: number;
}

/** Semantic icon for each overflow menu row (matches the Contact/Profile rows). */
const OVERFLOW_ICON: Record<ConversationActionKey, IconName> = {
  disappearing: 'timer',
  verify: 'verified',
  safety: 'shield',
  hide: 'hide',
};

/** Fallback anchor used until the ⋮ button has been measured (top-right corner). */
const DEFAULT_ANCHOR: OverflowMenuAnchor = { top: 56, right: 12 };

export interface ConversationOverflowMenuProps {
  /** Whether the menu is open. */
  visible: boolean;
  /** Dismiss the menu (backdrop tap / hardware back). */
  onClose: () => void;
  /** A menu row was chosen; routes to the existing action sheet for that flow. */
  onSelect: (key: ConversationActionKey) => void;
  theme: Theme;
  /** Whether the chat is hidden (the destructive row toggles its label to "Unhide chat"). */
  isHidden?: boolean;
  /** Screen-space position of the ⋮ button so the dropdown lines up under it. */
  anchor?: OverflowMenuAnchor | null;
  /**
   * Shadow-chat PIN settings entry point (Shadow Chat, task 16.1, Req 12.5/12.8). When provided, an
   * extra "Shadow chat PIN" row is rendered at the TOP of the menu. The container passes this ONLY
   * for an open shadow thread in App_Mode `real`; it is absent (no row) for surface chats and in any
   * non-real mode, so the per-chat-PIN control is inert under coercion (Req 12.8).
   */
  onShadowPinSettings?: (() => void) | null;
  /**
   * Local "Clear chat" history purge entry point (privacy-first, local-only). When provided, a
   * destructive "Clear chat" row is rendered at the BOTTOM of the menu. The container passes this
   * ONLY for an open SURFACE chat in App_Mode `real` (matching the existing destructive "hide"
   * gating); it is absent (no row) for a shadow thread and in any non-real mode.
   */
  onClearChat?: (() => void) | null;
}

/**
 * The conversation overflow menu, mounted at the top overlay layer via a `Modal` portal so it
 * always draws above the message list (task 17.2). Positioning is done with flex layout + padding
 * derived from the measured anchor, so the menu is NOT an absolutely-positioned sibling of the
 * message rows.
 */
export function ConversationOverflowMenu({
  visible,
  onClose,
  onSelect,
  theme: t,
  isHidden = false,
  anchor,
  onShadowPinSettings,
  onClearChat,
}: ConversationOverflowMenuProps): React.JSX.Element {
  const pos = anchor ?? DEFAULT_ANCHOR;
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      {/* Full-screen backdrop at the root overlay layer; tapping it dismisses the menu. */}
      <Pressable
        style={[styles.scrim, { paddingTop: pos.top, paddingRight: pos.right }]}
        onPress={onClose}
        accessibilityLabel="Dismiss menu"
      >
        {/* Inner Pressable absorbs taps so selecting/scrolling the menu does not dismiss it. */}
        <Pressable
          style={[styles.menu, { backgroundColor: t.surface, borderColor: t.divider }]}
          onPress={() => undefined}
        >
          {/* Shadow-chat PIN settings — present ONLY for an open shadow thread in real mode (task
              16.1, Req 12.5/12.8). Rendered above the standard actions; absent otherwise. */}
          {onShadowPinSettings != null && (
            <Pressable
              onPress={onShadowPinSettings}
              style={styles.item}
              accessibilityRole="button"
              accessibilityLabel="Shadow chat PIN"
            >
              <Icon name="settings" size={18} color={t.subtext} />
              <Text style={[styles.text, { color: t.text }]}>Shadow chat PIN</Text>
            </Pressable>
          )}
          {CONVERSATION_ACTIONS.map((action, idx) => {
            const destructive = action.key === 'hide';
            return (
              <Pressable
                key={action.key}
                onPress={() => onSelect(action.key)}
                style={[
                  styles.item,
                  (idx > 0 || onShadowPinSettings != null) && {
                    borderTopWidth: StyleSheet.hairlineWidth,
                    borderTopColor: t.divider,
                  },
                ]}
                accessibilityRole="button"
                accessibilityLabel={action.label}
              >
                <Icon name={OVERFLOW_ICON[action.key]} size={18} color={destructive ? t.danger : t.subtext} />
                <Text style={[styles.text, { color: destructive ? t.danger : t.text }]}>
                  {destructive && isHidden ? 'Unhide chat' : action.label}
                </Text>
              </Pressable>
            );
          })}
          {/* Local "Clear chat" history purge — present ONLY for an open surface chat in real mode
              (privacy-first, local-only). Destructive, rendered at the bottom below the standard
              actions; absent for a shadow thread / non-real mode. */}
          {onClearChat != null && (
            <Pressable
              onPress={onClearChat}
              style={[styles.item, { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: t.divider }]}
              accessibilityRole="button"
              accessibilityLabel={CLEAR_CHAT_ACTION.label}
            >
              <Icon name="clear" size={18} color={t.danger} />
              <Text style={[styles.text, { color: t.danger }]}>{CLEAR_CHAT_ACTION.label}</Text>
            </Pressable>
          )}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  // Backdrop fills the modal root; the menu is pushed to the top-right via padding + flex alignment
  // (no absolute positioning, so it can never become an absolutely-positioned sibling of messages).
  scrim: { flex: 1, alignItems: 'flex-end' },
  menu: {
    minWidth: 210,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    paddingVertical: 4,
    elevation: 6,
    shadowColor: '#000',
    shadowOpacity: 0.12,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
  },
  item: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 13 },
  text: { fontSize: 15 },
});
