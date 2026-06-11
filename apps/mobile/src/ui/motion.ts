/**
 * Motion system (UX directive: "Animations communicate confidence").
 *
 * One shared layout-transition helper so every screen animates the same way: smooth, fast,
 * intentional. Durations stay inside the directive's 150–300ms band; easing is plain
 * ease-in-ease-out (no bounce, no elastic, no flashy transitions). `LayoutAnimation`
 * animates the NEXT layout pass, so screens call `animateNext()` immediately before a
 * state change that inserts/removes/moves views (new message bubble, list updates,
 * screen swaps).
 */

import { LayoutAnimation, Platform, UIManager } from 'react-native';

// Android (old architecture) needs the experimental flag once at module load.
if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

/** Standard transition: 200ms ease-in-ease-out fade+layout. */
export function animateNext(durationMs = 200): void {
  LayoutAnimation.configureNext({
    duration: durationMs,
    create: { type: 'easeInEaseOut', property: 'opacity' },
    update: { type: 'easeInEaseOut' },
    delete: { type: 'easeInEaseOut', property: 'opacity' },
  });
}
