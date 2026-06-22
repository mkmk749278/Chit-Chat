/**
 * Swipeable tab pager for the Lumin shell. Lays the three tab screens side by side and lets the user
 * SWIPE horizontally between them (Chats / Calls / Settings), with the {@link TabBar} pill tracking
 * the page under the finger. Tapping a tab animates to it. Built on RN's built-in `Animated` +
 * `PanResponder` (no extra native modules), and only claims horizontal gestures, so each screen's
 * vertical `FlatList` scroll keeps working.
 *
 * All three screens are mounted at once (a pager needs them laid out together); this replaces the
 * previous "render only the active tab" approach. The screens are presentational, so mounting them
 * together is cheap.
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Animated, Dimensions, type LayoutChangeEvent, PanResponder, StyleSheet, View } from 'react-native';

import { TabBar, type Tab } from './TabBar';

const ORDER: readonly Tab[] = ['chats', 'calls', 'settings'];
const LAST = ORDER.length - 1;

/**
 * The pager's springs MUST stay on the JS driver (`false`).
 *
 * `translateX` drives the track's `transform` (native-driver-safe on its own), but its
 * interpolation `progress` is handed to {@link TabBar}, which animates the pill's `left` and `width`
 * — LAYOUT props the native animated module does NOT support. Once `translateX` is moved to the
 * native driver, that same node feeds those unsupported props and React Native throws
 * "Style property 'left' is not supported by native animated module". In a release build there is no
 * red box to dismiss, so it crashes on launch (the shell mounts immediately) and the app never opens.
 * Keeping the whole graph JS-driven lets one value legally feed both `transform` and the pill layout.
 */
const USE_NATIVE_DRIVER = false;

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

export function TabPager({
  tab,
  onTabChange,
  chats,
  calls,
  settings,
}: {
  tab: Tab;
  onTabChange: (tab: Tab) => void;
  chats: React.ReactNode;
  calls: React.ReactNode;
  settings: React.ReactNode;
}): React.JSX.Element {
  const [width, setWidth] = useState(() => Dimensions.get('window').width);
  const index = Math.max(0, ORDER.indexOf(tab));

  const translateX = useRef(new Animated.Value(-index * width)).current;
  // Mutable mirrors so the (created-once) PanResponder never reads stale props/state.
  const baseX = useRef(-index * width);
  const widthRef = useRef(width);
  const tabRef = useRef(tab);
  const onChangeRef = useRef(onTabChange);
  widthRef.current = width;
  tabRef.current = tab;
  onChangeRef.current = onTabChange;

  // Settle on the active tab whenever it changes (tab tap) or the width is (re)measured.
  useEffect(() => {
    const target = -index * width;
    baseX.current = target;
    Animated.spring(translateX, { toValue: target, useNativeDriver: USE_NATIVE_DRIVER, speed: 16, bounciness: 0 }).start();
  }, [index, width, translateX]);

  // Live 0..2 page position for the pill, recomputed if the width changes.
  const progress = useMemo(
    () =>
      translateX.interpolate({
        inputRange: [-LAST * width, 0],
        outputRange: [LAST, 0],
        extrapolate: 'clamp',
      }),
    [translateX, width],
  );

  const pan = useMemo(
    () =>
      PanResponder.create({
        // Claim only clearly-horizontal drags so vertical list scrolling is untouched.
        onMoveShouldSetPanResponder: (_e, g) =>
          Math.abs(g.dx) > 12 && Math.abs(g.dx) > Math.abs(g.dy) * 1.4,
        onPanResponderGrant: () => {
          translateX.stopAnimation((v) => {
            baseX.current = v;
          });
        },
        onPanResponderMove: (_e, g) => {
          const w = widthRef.current;
          translateX.setValue(clamp(baseX.current + g.dx, -LAST * w, 0));
        },
        onPanResponderRelease: (_e, g) => {
          const w = widthRef.current;
          const from = clamp(Math.round(-baseX.current / w), 0, LAST);
          // A deliberate drag past ~⅓ of the page, or a fast flick, advances one tab.
          let target = from;
          if (g.vx < -0.3 || g.dx < -w / 3) target = from + 1;
          else if (g.vx > 0.3 || g.dx > w / 3) target = from - 1;
          target = clamp(target, 0, LAST);
          baseX.current = -target * w;
          Animated.spring(translateX, {
            toValue: baseX.current,
            useNativeDriver: USE_NATIVE_DRIVER,
            speed: 16,
            bounciness: 0,
          }).start();
          const next = ORDER[target]!;
          if (next !== tabRef.current) onChangeRef.current(next);
        },
      }),
    [translateX],
  );

  const onLayout = (e: LayoutChangeEvent): void => {
    const w = e.nativeEvent.layout.width;
    if (w > 0 && w !== width) setWidth(w);
  };

  return (
    <View style={styles.container} onLayout={onLayout}>
      <Animated.View
        style={[styles.track, { width: width * ORDER.length, transform: [{ translateX }] }]}
        {...pan.panHandlers}
      >
        <View style={{ width }}>{chats}</View>
        <View style={{ width }}>{calls}</View>
        <View style={{ width }}>{settings}</View>
      </Animated.View>
      <TabBar active={tab} onSelect={onTabChange} progress={progress} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, overflow: 'hidden' },
  track: { flex: 1, flexDirection: 'row' },
});
