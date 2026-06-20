/**
 * Regression check for the conversation `⋮` overflow-menu z-order (task 17.3).
 *
 * Bug (task 17.2): the overflow menu used to be rendered as a pair of absolutely-positioned siblings
 * (`overflowScrim` + `overflowMenu`) INSIDE the conversation header `View`, sharing the message
 * list's stacking context — so it drew *behind* message bubbles. The fix re-renders the menu through
 * a top-level React Native `Modal` portal (the same approach as `SheetModal`), which mounts at the
 * root overlay layer ABOVE the entire view tree.
 *
 * These run under `node --test` (no React Native renderer is configured in this repo), so this is a
 * static/adapter regression check over the component source: it asserts the menu now mounts via a
 * `Modal` portal and is NOT an absolutely-positioned sibling of the message rows.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

// The compiled test lives in `dist/ui/`; the TSX sources live in `src/ui/`.
const SRC_UI = path.resolve(__dirname, '../../src/ui');
const overflowMenuSrc = readFileSync(path.join(SRC_UI, 'ConversationOverflowMenu.tsx'), 'utf8');
const conversationScreenSrc = readFileSync(path.join(SRC_UI, 'ConversationScreen.tsx'), 'utf8');

test('overflow menu mounts at the top overlay layer via a Modal portal', () => {
  // It imports `Modal` from react-native and renders through it (portal at the root overlay layer).
  assert.match(
    overflowMenuSrc,
    /import\s*\{[^}]*\bModal\b[^}]*\}\s*from\s*'react-native'/,
    'expected ConversationOverflowMenu to import Modal from react-native',
  );
  assert.match(overflowMenuSrc, /<Modal\b/, 'expected the overflow menu to render through <Modal>');
});

test('overflow menu is NOT an absolutely-positioned sibling of message rows', () => {
  // Inside a Modal portal, layout is done with flex + padding — never absolute positioning, which is
  // what made the old sibling implementation collide with the message-list stacking context.
  assert.doesNotMatch(
    overflowMenuSrc,
    /position:\s*'absolute'/,
    'overflow menu must not use absolute positioning; it should layout within the Modal portal',
  );
});

test('ConversationScreen renders the menu via the portal component, not an inline absolute sibling', () => {
  // The screen mounts the dedicated portal component...
  assert.match(
    conversationScreenSrc,
    /<ConversationOverflowMenu\b/,
    'ConversationScreen should mount <ConversationOverflowMenu> (the portal-based menu)',
  );
  // ...and no longer carries the old absolutely-positioned scrim/menu siblings.
  assert.doesNotMatch(
    conversationScreenSrc,
    /overflowScrim|overflowMenu:/,
    'ConversationScreen must not define the old absolutely-positioned overflow scrim/menu siblings',
  );
});
