/**
 * `clear-chat` — local "Clear chat" history purge for a SURFACE conversation (local-only feature).
 *
 * Privacy-first, FROZEN-server feature: clearing a chat is entirely on-device. It selects the
 * persisted message rows that belong to the surface conversation (rows whose `remoteUid` equals the
 * conversation id) and purges them through the same best-effort secure-erase path the disappearing /
 * view-once flows already use (`KeyStore.purgeMessages`). It performs NO network I/O and makes no
 * wire change. The chat itself is not deleted — it stays in the list (now empty) once the UI
 * dispatches the `conversation-cleared` reducer event.
 *
 * SCOPE: surface chats only. Shadow threads are intentionally NOT cleared here — their rows cannot be
 * cleanly isolated by `remoteUid` yet (a shadow thread shares the peer's surface conversation key on
 * the wire), so the action is simply not offered for a shadow thread (a follow-up).
 *
 * This module is deliberately free of any React Native / platform imports so it is a pure, narrowly
 * typed unit that the controller delegates to and that is unit-testable under `node --test`.
 */

import type { KeyStore, MessageRow } from '@chat-app/crypto';

/**
 * Select the persisted row ids belonging to a SURFACE conversation, i.e. rows whose `remoteUid`
 * matches `conversationId`. Returns the ids in stored order; rows for other conversations are never
 * included, so a clear can only ever touch the targeted conversation.
 */
export function selectClearableRowIds(
  rows: readonly MessageRow[],
  conversationId: string,
): string[] {
  return rows.filter((row) => row.remoteUid === conversationId).map((row) => row.id);
}

/**
 * Clear a surface conversation's LOCAL history: load every persisted row, select the ids belonging
 * to `conversationId`, and purge exactly those (best-effort secure erase). Fail-soft on a store
 * error — a failure must not crash the UI, mirroring the existing purge path (`markViewed`); the
 * rows simply remain until a later attempt. No-op when the conversation has no persisted rows.
 *
 * Takes only the narrow {@link KeyStore} surface it needs so it is trivially testable with a fake.
 */
export async function clearConversationHistory(
  keyStore: Pick<KeyStore, 'loadMessages' | 'purgeMessages'>,
  conversationId: string,
): Promise<void> {
  try {
    const rows = await keyStore.loadMessages();
    const ids = selectClearableRowIds(rows, conversationId);
    if (ids.length > 0) {
      await keyStore.purgeMessages(ids);
    }
  } catch {
    // A store error must not crash the UI; the rows stay until a later relaunch/attempt.
  }
}

/**
 * DELETE a surface conversation entirely (the "Delete chat" action). Unlike {@link
 * clearConversationHistory} — which empties the chat but leaves it in the list — this purges every
 * persisted row AND resets the per-conversation disappearing-message timer to `0`, so the
 * conversation does NOT rehydrate on the next launch (rehydration groups by surviving rows) and no
 * stale timer lingers. The caller is responsible for removing the now-orphaned conversation from the
 * in-memory list and leaving its view. Local-only (no network, no wire change) and fail-soft on a
 * store error, mirroring the clear/purge paths.
 *
 * Takes only the narrow {@link KeyStore} surface it needs so it is trivially testable with a fake.
 */
export async function deleteConversation(
  keyStore: Pick<KeyStore, 'loadMessages' | 'purgeMessages' | 'setConversationTimer'>,
  conversationId: string,
): Promise<void> {
  try {
    const rows = await keyStore.loadMessages();
    const ids = selectClearableRowIds(rows, conversationId);
    if (ids.length > 0) {
      await keyStore.purgeMessages(ids);
    }
    // Reset the timer so a stale entry can't outlive the deleted conversation (best-effort).
    await keyStore.setConversationTimer(conversationId, 0);
  } catch {
    // A store error must not crash the UI; the rows stay until a later relaunch/attempt.
  }
}
