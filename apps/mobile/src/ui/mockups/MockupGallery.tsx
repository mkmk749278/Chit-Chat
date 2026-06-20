/**
 * MOCKUP GALLERY — one component to view the whole UI redesign.
 *
 * HOW TO VIEW THESE MOCKUPS
 * -------------------------
 * These screens are design-only and isolated under `apps/mobile/src/ui/mockups/`.
 * They do NOT touch production wiring. To see them on a device/simulator, you can
 * TEMPORARILY render this gallery from the app entry point, e.g. in `App.tsx`:
 *
 *     // import { MockupGallery } from './src/ui/mockups/MockupGallery';
 *     // return <MockupGallery />;   // <- temporary; remove before shipping
 *
 * (Do NOT commit that change — this file is the single entry point for the demo,
 * and the task explicitly keeps App.tsx runtime behavior unchanged.)
 *
 * The gallery renders a top segmented switcher and the selected mockup below it,
 * so the full redesign — clean conversation header, chronological grouped chat,
 * the new contact/profile screen, the modernized chat list, and the non-freezing
 * unlock — can be flipped through in one place.
 */

import React, { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { AppLockScreenMockup } from './AppLockScreenMockup';
import { ChatsListScreenMockup } from './ChatsListScreenMockup';
import { ContactProfileScreenMockup } from './ContactProfileScreenMockup';
import { ConversationScreenMockup } from './ConversationScreenMockup';
import { radius, spacing, type, useTheme } from './theme.mockup';

type ScreenKey = 'conversation' | 'profile' | 'chats' | 'lock';

const TABS: ReadonlyArray<{ key: ScreenKey; label: string }> = [
  { key: 'conversation', label: 'Conversation' },
  { key: 'chats', label: 'Chats list' },
  { key: 'profile', label: 'Profile' },
  { key: 'lock', label: 'App lock' },
];

export function MockupGallery(): React.JSX.Element {
  const t = useTheme();
  const [active, setActive] = useState<ScreenKey>('conversation');

  // Local nav: tapping the conversation header avatar jumps to the profile mockup.
  const goProfile = (): void => setActive('profile');
  const goChats = (): void => setActive('chats');

  return (
    <View style={[styles.root, { backgroundColor: t.bg }]}>
      {/* Segmented switcher */}
      <View style={[styles.switcher, { backgroundColor: t.surface, borderBottomColor: t.divider }]}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.switcherRow}>
          {TABS.map((tab) => {
            const selected = tab.key === active;
            return (
              <Pressable
                key={tab.key}
                onPress={() => setActive(tab.key)}
                style={[
                  styles.segment,
                  { backgroundColor: selected ? t.brand : t.field },
                ]}
                accessibilityRole="button"
                accessibilityState={{ selected }}
              >
                <Text style={[styles.segmentText, { color: selected ? t.onBrand : t.subtext }]}>
                  {tab.label}
                </Text>
              </Pressable>
            );
          })}
        </ScrollView>
      </View>

      {/* Selected mockup fills the rest of the screen. */}
      <View style={styles.stage}>
        {active === 'conversation' && <ConversationScreenMockup onOpenProfile={goProfile} onBack={goChats} />}
        {active === 'chats' && <ChatsListScreenMockup />}
        {active === 'profile' && <ContactProfileScreenMockup onBack={() => setActive('conversation')} />}
        {active === 'lock' && <AppLockScreenMockup />}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  switcher: { paddingTop: spacing.xxl, borderBottomWidth: StyleSheet.hairlineWidth },
  switcherRow: { gap: spacing.sm, paddingHorizontal: spacing.md, paddingBottom: spacing.sm },
  segment: { paddingHorizontal: spacing.lg, paddingVertical: spacing.sm, borderRadius: radius.pill },
  segmentText: { ...type.meta },
  stage: { flex: 1 },
});
