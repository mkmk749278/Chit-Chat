/**
 * Example tests for the P3 conversation header redesign (Requirements 3.1–3.4).
 *
 * The overflow menu (`ConversationScreen`) and the Contact/Profile screen (`ContactProfileScreen`)
 * both render their action rows from the single shared {@link CONVERSATION_ACTIONS} model, and the
 * redesigned header renders {@link CONVERSATION_HEADER_ELEMENTS}. Asserting against that shared model
 * proves the four moved actions are reachable in BOTH surfaces and that the header carries exactly
 * back · avatar · name · status · overflow — without rendering React Native (these run under
 * `node --test`).
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  CLEAR_CHAT_ACTION,
  CONVERSATION_ACTIONS,
  CONVERSATION_HEADER_ELEMENTS,
  conversationActionKeys,
  type ConversationActionKey,
} from './conversation-actions';

const MOVED_ACTIONS: readonly ConversationActionKey[] = ['disappearing', 'verify', 'safety', 'hide'];

test('all four moved actions are reachable via the overflow menu and the profile screen', () => {
  // Both surfaces iterate CONVERSATION_ACTIONS, so membership here == reachable in both places.
  for (const key of MOVED_ACTIONS) {
    assert.ok(
      CONVERSATION_ACTIONS.some((a) => a.key === key),
      `expected action "${key}" to be present in the shared action model`,
    );
  }
  // Exactly the four actions, no more, no fewer.
  assert.deepEqual([...conversationActionKeys()].sort(), [...MOVED_ACTIONS].sort());
});

test('every moved action carries a non-empty human label for the menu/profile row', () => {
  for (const action of CONVERSATION_ACTIONS) {
    assert.equal(typeof action.label, 'string');
    assert.ok(action.label.trim().length > 0, `action "${action.key}" must have a label`);
  }
});

test('redesigned header shows back, avatar, name, status, overflow (left → right)', () => {
  assert.deepEqual(
    [...CONVERSATION_HEADER_ELEMENTS],
    ['back', 'avatar', 'name', 'status', 'overflow'],
  );
});

test('Clear chat is a separate action (not one of the four moved actions) with a non-empty label', () => {
  // It must NOT leak into the shared four-action header/profile model (which would show it for shadow
  // threads and break the four-action invariant); it is rendered conditionally in the overflow menu.
  assert.equal(CLEAR_CHAT_ACTION.key, 'clear');
  assert.equal(CLEAR_CHAT_ACTION.label, 'Clear chat');
  assert.ok(CLEAR_CHAT_ACTION.label.trim().length > 0);
  assert.ok(
    !conversationActionKeys().includes(CLEAR_CHAT_ACTION.key as ConversationActionKey),
    'Clear chat must not be a member of the four moved actions',
  );
});
