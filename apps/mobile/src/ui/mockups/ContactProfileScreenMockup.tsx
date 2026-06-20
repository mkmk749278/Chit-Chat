/**
 * MOCKUP — Contact / Profile screen (P3, NEW screen).
 *
 * Opened by tapping the name/avatar in the redesigned conversation header. It is
 * the new home for the actions that used to be crammed into the header as five
 * emoji icons. Per the design (Component 7), it surfaces:
 *   - a large avatar + name + an "encrypted / verified" badge row, and
 *   - grouped action rows: Disappearing messages (with current value),
 *     Verify identity, View safety number, Hide chat.
 *
 * Hard-coded sample data only — no crypto, no real callbacks.
 */

import React from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { Icon, type IconName } from './Icon.mockup';
import { avatarColor, initials, radius, spacing, type, useTheme } from './theme.mockup';

interface ActionRow {
  icon: IconName;
  label: string;
  /** Current value shown on the right (e.g. the active timer). */
  value?: string;
  destructive?: boolean;
}

const ACTIONS: ActionRow[] = [
  { icon: 'timer', label: 'Disappearing messages', value: '1 day' },
  { icon: 'verified', label: 'Verify identity', value: 'Verified' },
  { icon: 'shield', label: 'View safety number' },
  { icon: 'hide', label: 'Hide chat', destructive: true },
];

export interface ContactProfileScreenMockupProps {
  peerName?: string;
  onBack?: () => void;
}

export function ContactProfileScreenMockup({
  peerName = 'Maya Patel',
  onBack,
}: ContactProfileScreenMockupProps): React.JSX.Element {
  const t = useTheme();

  return (
    <View style={[styles.screen, { backgroundColor: t.bg }]}>
      <View style={[styles.topBar, { borderBottomColor: t.divider, backgroundColor: t.surface }]}>
        <Pressable hitSlop={12} onPress={onBack} accessibilityRole="button" accessibilityLabel="Back">
          <Icon name="back" size={24} color={t.brandSoft} />
        </Pressable>
        <Text style={[styles.topTitle, { color: t.text }]}>Contact info</Text>
        <View style={styles.topSpacer} />
      </View>

      <ScrollView contentContainerStyle={styles.content}>
        {/* Identity block */}
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
            <View style={[styles.badge, { backgroundColor: t.brandFill }]}>
              <Icon name="verified" size={14} color={t.secure} />
              <Text style={[styles.badgeText, { color: t.secure }]}>Verified</Text>
            </View>
          </View>
        </View>

        {/* Grouped action list */}
        <View style={[styles.group, { backgroundColor: t.surface, borderColor: t.divider }]}>
          {ACTIONS.map((row, idx) => (
            <Pressable
              key={row.label}
              style={[
                styles.row,
                idx > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: t.divider },
              ]}
              accessibilityRole="button"
              accessibilityLabel={row.label}
            >
              <View style={styles.rowIcon}>
                <Icon name={row.icon} size={20} color={row.destructive === true ? t.danger : t.subtext} />
              </View>
              <Text
                style={[styles.rowLabel, { color: row.destructive === true ? t.danger : t.text }]}
                numberOfLines={1}
              >
                {row.label}
              </Text>
              {row.value !== undefined && (
                <Text style={[styles.rowValue, { color: t.faint }]}>{row.value}</Text>
              )}
              <Icon name="chevron-right" size={18} color={t.faint} />
            </Pressable>
          ))}
        </View>

        <Text style={[styles.footnote, { color: t.faint }]}>
          Messages and calls are end-to-end encrypted. Tap “View safety number” to confirm {peerName}’s
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
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    gap: spacing.md,
  },
  topTitle: { ...type.heading, flex: 1 },
  topSpacer: { width: 24 },
  content: { paddingBottom: spacing.xxl },
  identity: { alignItems: 'center', paddingVertical: spacing.xl },
  avatarLarge: { width: 96, height: 96, borderRadius: 48, alignItems: 'center', justifyContent: 'center' },
  avatarLargeText: { color: '#fff', fontSize: 34, fontWeight: '700' },
  name: { ...type.title, marginTop: spacing.lg },
  badgeRow: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.md },
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    borderRadius: radius.pill,
  },
  badgeText: { ...type.meta },
  group: {
    marginHorizontal: spacing.lg,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
  },
  row: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: spacing.lg, paddingVertical: spacing.lg, gap: spacing.md },
  rowIcon: { width: 24, alignItems: 'center' },
  rowLabel: { ...type.body, flex: 1 },
  rowValue: { ...type.meta },
  footnote: { ...type.meta, textAlign: 'center', paddingHorizontal: spacing.xl, marginTop: spacing.xl, lineHeight: 18 },
});
