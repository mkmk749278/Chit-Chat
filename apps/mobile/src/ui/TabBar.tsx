/**
 * Bottom tab bar for the Lumin shell (UX directive: Chats / Calls / Settings).
 *
 * Deliberately state-driven (no React Navigation): a 3-tab shell does not justify the
 * two extra native modules React Navigation requires (react-native-screens,
 * safe-area-context), which would add APK-build risk for no UX gain at this size. The
 * container owns the active tab and screen stack; this component only renders and
 * reports taps.
 */

import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Icon, type IconName } from './icons';
import { useTheme } from './theme';

export type Tab = 'chats' | 'calls' | 'settings';

// UX directive navigation: Chats / Calls / Settings (max 4 tabs; new chat is an action on
// the Chats screen, not a destination). Icons use the shared vector-icon set (Req 3.9).
const TABS: ReadonlyArray<{ key: Tab; icon: IconName; label: string }> = [
  { key: 'chats', icon: 'chats', label: 'Chats' },
  { key: 'calls', icon: 'calls', label: 'Calls' },
  { key: 'settings', icon: 'settings', label: 'Settings' },
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
            <View style={[styles.icon, !selected && styles.iconInactive]}>
              <Icon name={tab.icon} size={22} color={selected ? t.brandSoft : t.faint} />
            </View>
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
  icon: { height: 24, alignItems: 'center', justifyContent: 'center' },
  iconInactive: { opacity: 0.55 },
  label: { fontSize: 11 },
});
