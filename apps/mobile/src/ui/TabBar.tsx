/**
 * Floating "pill" bottom navigation for the Lumin shell (Chats / Calls / Settings).
 *
 * Modern Material-You-style nav: a detached, rounded, shadowed bar; the ACTIVE tab sits inside a
 * sliding brand pill that shows its label, while inactive tabs are icon-only. The pill position +
 * width are driven by an optional `progress` animated value (0..2, the live page position from
 * {@link TabPager}) so the pill TRACKS THE FINGER as you swipe between tabs; without it the pill
 * snaps to the active tab. Still state-driven (no React Navigation) — the container owns the tab.
 */

import React, { useState } from 'react';
import { Animated, type LayoutChangeEvent, Pressable, StyleSheet, Text, View } from 'react-native';

import { Icon, type IconName } from './icons';
import { useTheme } from './theme';

export type Tab = 'chats' | 'calls' | 'settings';

// Navigation: Chats / Calls / Settings (new chat is an action on the Chats screen, not a tab).
const TABS: ReadonlyArray<{ key: Tab; icon: IconName; label: string }> = [
  { key: 'chats', icon: 'chats', label: 'Chats' },
  { key: 'calls', icon: 'calls', label: 'Calls' },
  { key: 'settings', icon: 'settings', label: 'Settings' },
];

/** Pill width for a tab: icon + gap + label text + horizontal padding (approximate, label-sized). */
const pillWidthFor = (label: string): number => 30 + label.length * 8 + 22;

export function TabBar({
  active,
  onSelect,
  progress,
}: {
  active: Tab;
  onSelect: (tab: Tab) => void;
  /** Live page position 0..2 from the pager; when present the pill follows it continuously. */
  progress?: Animated.AnimatedInterpolation<number>;
}): React.JSX.Element {
  const t = useTheme();
  const [navW, setNavW] = useState(0);
  const n = TABS.length;
  const itemW = navW > 0 ? navW / n : 0;
  const activeIndex = Math.max(0, TABS.findIndex((x) => x.key === active));
  const pillWidths = TABS.map((x) => pillWidthFor(x.label));
  // Left edge that centers tab i's pill within its equal-width slot.
  const leftFor = (i: number): number => itemW * i + (itemW - pillWidths[i]!) / 2;

  // Pill geometry: follow the swipe `progress` if provided (and measured), else snap to active.
  const followable = progress !== undefined && navW > 0;
  const pillLeft: number | Animated.AnimatedInterpolation<number> = followable
    ? progress.interpolate({
        inputRange: [0, 1, 2],
        outputRange: [leftFor(0), leftFor(1), leftFor(2)],
        extrapolate: 'clamp',
      })
    : leftFor(activeIndex);
  const pillWidth: number | Animated.AnimatedInterpolation<number> = followable
    ? progress.interpolate({ inputRange: [0, 1, 2], outputRange: pillWidths, extrapolate: 'clamp' })
    : pillWidths[activeIndex]!;

  return (
    <View pointerEvents="box-none" style={styles.wrap}>
      <View
        style={[styles.bar, { backgroundColor: t.surface, shadowColor: '#000' }]}
        onLayout={(e: LayoutChangeEvent) => setNavW(e.nativeEvent.layout.width)}
      >
        {navW > 0 && (
          <Animated.View
            style={[styles.pill, { backgroundColor: t.brandFill, left: pillLeft, width: pillWidth }]}
            pointerEvents="none"
          />
        )}
        {TABS.map((tab) => {
          const selected = tab.key === active;
          return (
            <Pressable
              key={tab.key}
              style={styles.item}
              onPress={() => onSelect(tab.key)}
              accessibilityRole="tab"
              accessibilityState={{ selected }}
              accessibilityLabel={tab.label}
            >
              <Icon name={tab.icon} size={22} color={selected ? t.brand : t.faint} />
              {selected && (
                <Text style={[styles.label, { color: t.brand }]} numberOfLines={1}>
                  {tab.label}
                </Text>
              )}
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  // Absolute, floating over the screen content; box-none lets touches above the bar reach content.
  wrap: { position: 'absolute', left: 0, right: 0, bottom: 0, paddingHorizontal: 14, paddingBottom: 18 },
  bar: {
    flexDirection: 'row',
    height: 64,
    borderRadius: 26,
    alignItems: 'center',
    // Soft floating shadow (iOS) + elevation (Android).
    shadowOpacity: 0.18,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 8 },
    elevation: 12,
  },
  pill: { position: 'absolute', top: 9, height: 46, borderRadius: 23 },
  item: { flex: 1, height: '100%', flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7 },
  label: { fontSize: 13.5, fontWeight: '700' },
});
