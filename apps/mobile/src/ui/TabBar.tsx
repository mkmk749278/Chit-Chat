/**
 * Bottom tab bar for the Lumin shell (design/mockups: Chats / Contacts / Settings).
 *
 * Deliberately state-driven (no React Navigation): a 3-tab shell does not justify the
 * two extra native modules React Navigation requires (react-native-screens,
 * safe-area-context), which would add APK-build risk for no UX gain at this size. The
 * container owns the active tab and screen stack; this component only renders and
 * reports taps.
 */

import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { useTheme } from './theme';

export type Tab = 'chats' | 'contacts' | 'settings';

const TABS: ReadonlyArray<{ key: Tab; icon: string; label: string }> = [
  { key: 'chats', icon: '💬', label: 'Chats' },
  { key: 'contacts', icon: '👤', label: 'Contacts' },
  { key: 'settings', icon: '⚙️', label: 'Settings' },
];

export function TabBar({
  active,
  onSelect,
}: {
  active: Tab;
  onSelect: (tab: Tab) => void;
}): React.JSX.Element {
  const t = useTheme();
  return (
    <View style={[styles.bar, { backgroundColor: t.surface, borderTopColor: t.divider }]}>
      {TABS.map((tab) => {
        const selected = tab.key === active;
        return (
          <Pressable
            key={tab.key}
            style={styles.item}
            onPress={() => onSelect(tab.key)}
            accessibilityRole="tab"
            accessibilityState={{ selected }}
          >
            <Text style={[styles.icon, !selected && styles.iconInactive]}>{tab.icon}</Text>
            <Text
              style={[
                styles.label,
                { color: selected ? t.brandSoft : t.faint, fontWeight: selected ? '700' : '400' },
              ]}
            >
              {tab.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    borderTopWidth: 1,
    paddingTop: 8,
    paddingBottom: 20,
  },
  item: { flex: 1, alignItems: 'center', gap: 2 },
  icon: { fontSize: 20 },
  iconInactive: { opacity: 0.45 },
  label: { fontSize: 11 },
});
