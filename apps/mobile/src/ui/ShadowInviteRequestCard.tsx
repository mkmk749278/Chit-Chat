/**
 * `ShadowInviteRequestCard` — the Accept / Decline request card for an inbound shadow-chat invite
 * (Shadow Chat Invites, design Component A; Req 1.3, 3.1). It renders as a top-level sheet (the same
 * `SheetModal` portal the row/overflow menus use) when a `shadow-invite` arrives in real mode. On
 * Accept it reveals the routing choice — `hidden` (default) or `merge` — then resolves with the
 * chosen routing; on Decline it resolves with no shadow data persisted. The card auto-dismisses when
 * the container drops it on `invite-resolved` (so there is no invite residue).
 *
 * Pure presentation: all gating (real-mode only) and the card lifecycle live in the container, which
 * folds {@link ShadowInviteEvent}s through `reduceInviteCards` and gates on `showShadowChatLongPress`.
 */

import React, { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import type { RecipientRouting } from '@chat-app/crypto';

import { SheetItem, SheetModal, sheetStyles } from './action-sheet';
import { DEFAULT_RECIPIENT_ROUTING, ROUTING_OPTIONS } from './shadow-invite-actions';
import type { Theme } from './theme';

export interface ShadowInviteRequestCardProps {
  /** Whether a request card is currently shown. */
  visible: boolean;
  theme: Theme;
  /** Display name (or UID) of the inviter, shown on the card. */
  peerName: string;
  /** Optional human-readable thread label the inviter attached (blank by default for deniability). */
  label?: string;
  /** Accept the invite with the chosen routing (the choice stays local to this device). */
  onAccept: (routing: RecipientRouting) => void;
  /** Decline the invite (persists no shadow data). */
  onDecline: () => void;
  /** Dismiss without choosing (e.g. backdrop tap) — treated as "decide later", not decline. */
  onClose: () => void;
}

/** The two-step invite card: ask → (Accept) choose routing, or (Decline). */
export function ShadowInviteRequestCard({
  visible,
  theme: t,
  peerName,
  label,
  onAccept,
  onDecline,
  onClose,
}: ShadowInviteRequestCardProps): React.JSX.Element {
  const [choosingRouting, setChoosingRouting] = useState(false);

  // Reset to the ask step whenever the card is (re)opened.
  const close = (): void => {
    setChoosingRouting(false);
    onClose();
  };

  return (
    <SheetModal visible={visible} onClose={close} theme={t}>
      <View style={styles.header}>
        <Text style={[sheetStyles.sheetTitle, { color: t.text }]} numberOfLines={1}>
          Shadow chat invite
        </Text>
        <Text style={[styles.subtitle, { color: t.subtext }]} numberOfLines={2}>
          {peerName}
          {label !== undefined && label.length > 0 ? ` · ${label}` : ''} wants to start a private
          shadow chat with you.
        </Text>
      </View>

      {!choosingRouting ? (
        <>
          <SheetItem label="Accept" onPress={() => setChoosingRouting(true)} theme={t} />
          <SheetItem
            label="Decline"
            onPress={() => {
              setChoosingRouting(false);
              onDecline();
            }}
            theme={t}
            destructive
          />
        </>
      ) : (
        <>
          <Text style={[styles.routingHint, { color: t.subtext }]}>
            Where should this chat appear on your device?
          </Text>
          {ROUTING_OPTIONS.map((option) => (
            <SheetItem
              key={option.value}
              label={
                option.value === DEFAULT_RECIPIENT_ROUTING
                  ? `${option.label} (recommended)`
                  : option.label
              }
              onPress={() => {
                setChoosingRouting(false);
                onAccept(option.value);
              }}
              theme={t}
            />
          ))}
          <SheetItem label="Back" onPress={() => setChoosingRouting(false)} theme={t} />
        </>
      )}
    </SheetModal>
  );
}

const styles = StyleSheet.create({
  header: { marginBottom: 4 },
  subtitle: { fontSize: 13, marginTop: 2 },
  routingHint: { fontSize: 13, marginTop: 6, marginBottom: 2 },
});
