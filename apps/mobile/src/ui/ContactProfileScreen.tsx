/**
 * Mobile `Contact_Profile_Screen` (P3 — design Component 7; visual: mockups §3, Requirement 3.4).
 *
 * Opened by tapping the avatar/name in the redesigned conversation header. It is the new home for
 * the four actions that used to crowd the header as emoji icons: disappearing messages, verify
 * identity, safety number, hide chat.
 *
 * Presentational and stateless: it renders an identity block (large avatar, name, encrypted/verified
 * badges) and a grouped action list built from the shared {@link CONVERSATION_ACTIONS} model, then
 * reports the chosen action via {@link ContactProfileScreenProps.onSelectAction}. The parent
 * (`ConversationScreen`) reuses its EXISTING action sheets and EXISTING callbacks (`onSetTimer`,
 * `getSafetyNumber`, `onRequestVerification` / `onRespondVerification`, `onHideChat` /
 * `onUnhideChat`) to actually run each flow — no container/state rewire, no duplicated sheet logic.
 */

import React from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import {
  CONVERSATION_ACTIONS,
  type ConversationActionKey,
} from './conversation-actions';
import { timerLabel } from './disappearing';
import { Icon, type IconName } from './icons';
import { avatarColor, initials, useTheme } from './theme';

export interface ContactProfileScreenProps {
  /** Display name of the chat peer. */
  peerName: string;
  /** Peer online state for opted-in presence; `null` = unknown/opted-out. */
  peerOnline?: boolean | null;
  /** Peer coarse last-seen (unix ms) when offline + opted-in, else `null`. */
  peerLastSeen?: number | null;
  /** Per-session in-chat verification status for this peer. */
  verification?: 'none' | 'requested' | 'incoming' | 'verified' | 'unverified';
  /** Active disappearing-message timer in ms (`0` = off) — shown as the row's current value. */
  disappearingTtlMs: number;
  /** Whether this chat is currently hidden. */
  isHidden?: boolean;
  /** Back to the conversation. */
  onBack: () => void;
  /**
   * Open one of the moved action flows. The parent reuses its EXISTING action sheets + callbacks to
   * run it (timer → onSetTimer, verify → onRequest/RespondVerification, safety → getSafetyNumber,
   * hide → onHideChat/onUnhideChat), so this screen never duplicates that logic (Req 3.4).
   */
  onSelectAction: (key: ConversationActionKey) => void;
}

/** Semantic icon for each action row. */
const ACTION_ICON: Record<ConversationActionKey, IconName> = {
  disappearing: 'timer',
  verify: 'verified',
  safety: 'shield',
  hide: 'hide',
};

/** Short label for the current verification state, shown on the "Verify identity" row. */
function verificationValue(v: ContactProfileScreenProps['verification']): string {
  switch (v) {
    case 'verified':
      return 'Verified';
    case 'requested':
      return 'Pending…';
    case 'incoming':
      return 'Respond';
    case 'unverified':
      return 'Unverified';
    default:
      return '';
  }
}

export function ContactProfileScreen({
  peerName,
  verification = 'none',
  disappearingTtlMs,
  isHidden = false,
  onBack,
  onSelectAction,
}: ContactProfileScreenProps): React.JSX.Element {
  const t = useTheme();

  // Per-action current-value text (right-aligned), derived from the same state the sheets use.
  const valueOf = (key: ConversationActionKey): string => {
    switch (key) {
      case 'disappearing':
        return disappearingTtlMs > 0 ? timerLabel(disappearingTtlMs) : '';
      case 'verify':
        return verificationValue(verification);
      case 'hide':
        return isHidden ? 'Hidden' : '';
      default:
        return '';
    }
  };

  return (
    <View style={[styles.screen, { backgroundColor: t.bg }]}>
      <View style={[styles.topBar, { borderBottomColor: t.divider, backgroundColor: t.surface }]}>
        <Pressable hitSlop={12} onPress={onBack} accessibilityRole="button" accessibilityLabel="Back">
          <Icon name="back" size={22} color={t.brandSoft} />
        </Pressable>
        <Text style={[styles.topTitle, { color: t.text }]}>Contact info</Text>
        <View style={styles.topSpacer} />
      </View>

      <ScrollView contentContainerStyle={styles.content}>
        {/* Identity block. */}
        <View style={styles.identity}>
          <View style={[styles.avatarLarge, { backgroundColor: avatarColor(peerName) }]}>
            <Text style={styles.avatarLargeText}>{initials(peerName)}</Text>
          </View>
          <Text style={[styles.name, { color: t.text }]}>{peerName}</Text>

          {/* Encrypted / verification badge row. */}
          <View style={styles.badgeRow}>
            <View style={[styles.badge, { backgroundColor: t.brandFill }]}>
              <Icon name="shield" size={14} color={t.brand} />
              <Text style={[styles.badgeText, { color: t.brand }]}>Encrypted</Text>
            </View>
            {verification === 'verified' && (
              <View style={[styles.badge, { backgroundColor: t.brandFill }]}>
                <Icon name="verified" size={14} color={t.secure} />
                <Text style={[styles.badgeText, { color: t.secure }]}>Verified</Text>
              </View>
            )}
          </View>
        </View>

        {/* Grouped action list — every action reachable here AND in the overflow menu. */}
        <View style={[styles.group, { backgroundColor: t.surface, borderColor: t.divider }]}>
          {CONVERSATION_ACTIONS.map((action, idx) => {
            const destructive = action.key === 'hide';
            const value = valueOf(action.key);
            return (
              <Pressable
                key={action.key}
                style={[
                  styles.row,
                  idx > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: t.divider },
                ]}
                accessibilityRole="button"
                accessibilityLabel={action.label}
                onPress={() => onSelectAction(action.key)}
              >
                <View style={styles.rowIcon}>
                  <Icon name={ACTION_ICON[action.key]} size={20} color={destructive ? t.danger : t.subtext} />
                </View>
                <Text
                  style={[styles.rowLabel, { color: destructive ? t.danger : t.text }]}
                  numberOfLines={1}
                >
                  {action.key === 'hide' && isHidden ? 'Unhide chat' : action.label}
                </Text>
                {value.length > 0 && <Text style={[styles.rowValue, { color: t.faint }]}>{value}</Text>}
                <Icon name="chevron-right" size={18} color={t.faint} />
              </Pressable>
            );
          })}
        </View>

        <Text style={[styles.footnote, { color: t.faint }]}>
          Messages and calls are end-to-end encrypted. Tap “Safety number” to confirm {peerName}’s
          identity on a trusted channel.
        </Text>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    gap: 12,
  },
  topTitle: { fontSize: 17, fontWeight: '700', flex: 1 },
  topSpacer: { width: 22 },
  content: { paddingBottom: 32 },
  identity: { alignItems: 'center', paddingVertical: 24 },
  avatarLarge: { width: 96, height: 96, borderRadius: 48, alignItems: 'center', justifyContent: 'center' },
  avatarLargeText: { color: '#fff', fontSize: 34, fontWeight: '700' },
  name: { fontSize: 26, fontWeight: '800', marginTop: 16 },
  badgeRow: { flexDirection: 'row', gap: 8, marginTop: 12 },
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 12,
    paddingVertical: 4,
    borderRadius: 999,
  },
  badgeText: { fontSize: 12, fontWeight: '500' },
  group: {
    marginHorizontal: 16,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
  },
  row: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 16, gap: 12 },
  rowIcon: { width: 24, alignItems: 'center' },
  rowLabel: { fontSize: 15, flex: 1 },
  rowValue: { fontSize: 12, fontWeight: '500' },
  footnote: { fontSize: 12, textAlign: 'center', paddingHorizontal: 24, marginTop: 24, lineHeight: 18 },
});
