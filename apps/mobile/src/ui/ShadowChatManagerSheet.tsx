/**
 * `ShadowChatManagerSheet` — a real-mode-only bottom sheet that lists the user's active shadow chats
 * and lets each be **cleared** (purge local history, keep the chat working) or **revoked** (delete the
 * shared key + history on both sides, close the thread). It exists so a shadow chat can be cleared
 * WITHOUT first reopening it via its `/alias` (Shadow Chat Invites, Req 6/7).
 *
 * Privacy: the container only opens this in App_Mode `real` and sources the list from
 * `controller.listShadowChats()`, which returns nothing in decoy/locked mode — so the sheet can never
 * reveal that shadow chats exist under coercion (design Correctness Properties 6, 16). It owns no
 * crypto/state; it routes the chosen action back through the container callbacks.
 *
 * Presentational, built on the shared {@link SheetModal}/{@link SheetItem} primitives (top z-order via
 * the Modal portal), so it draws above the rest of the app exactly like the other action sheets.
 */

import React from 'react';
import { Text, View } from 'react-native';

import { SheetItem, SheetModal, sheetStyles } from './action-sheet';
import type { Theme } from './theme';

/** One row in the manager: the thread to act on + a human label (resolved peer name or fallback). */
export interface ShadowChatManagerEntry {
  threadId: string;
  /** Display label — the resolved peer name, or a neutral fallback while it resolves. */
  name: string;
}

export interface ShadowChatManagerSheetProps {
  visible: boolean;
  onClose: () => void;
  theme: Theme;
  /** The active shadow chats to manage; empty renders an explanatory empty state. */
  chats: ReadonlyArray<ShadowChatManagerEntry>;
  /** The thread currently being cleared/revoked (its rows show a spinner), or null. */
  busyThreadId?: string | null;
  /** Clear THIS shadow chat's local history (keeps the chat working). */
  onClear: (threadId: string) => void;
  /** Revoke THIS shadow chat: delete the key + history on both sides and close it. Irreversible. */
  onRevoke: (threadId: string) => void;
}

export function ShadowChatManagerSheet({
  visible,
  onClose,
  theme: t,
  chats,
  busyThreadId = null,
  onClear,
  onRevoke,
}: ShadowChatManagerSheetProps): React.JSX.Element {
  return (
    <SheetModal visible={visible} onClose={onClose} theme={t}>
      <Text style={[sheetStyles.sheetTitle, { color: t.text }]}>Shadow chats</Text>
      <Text style={[sheetStyles.sheetHint, { color: t.faint }]}>
        Clear removes this shadow chat’s history on this device but keeps it working. Revoke deletes it
        for both sides and can’t be undone.
      </Text>
      {chats.length === 0 ? (
        <Text style={[sheetStyles.sheetHint, { color: t.faint }]}>No shadow chats.</Text>
      ) : (
        chats.map((chat) => {
          const busy = busyThreadId === chat.threadId;
          return (
            <View key={chat.threadId}>
              <Text style={[sheetStyles.sheetTitle, { color: t.text, marginTop: 14, marginBottom: 0 }]}>
                {chat.name}
              </Text>
              <SheetItem
                label="Clear shadow chat"
                theme={t}
                destructive
                busy={busy}
                disabled={busyThreadId !== null && !busy}
                onPress={() => onClear(chat.threadId)}
              />
              <SheetItem
                label="Revoke shadow chat"
                theme={t}
                destructive
                busy={busy}
                disabled={busyThreadId !== null && !busy}
                onPress={() => onRevoke(chat.threadId)}
              />
            </View>
          );
        })
      )}
      <SheetItem label="Done" theme={t} disabled={busyThreadId !== null} onPress={onClose} />
    </SheetModal>
  );
}
