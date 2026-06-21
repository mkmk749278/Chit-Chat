/**
 * `ShadowInviteRequestCard` — the Accept / Decline request card for an inbound shadow-chat invite
 * (Shadow Chat Invites, design Component A; Req 1.3, 3.1, 5). A single self-contained sheet (one
 * `Modal`, so there is never a two-modal present/dismiss race) that walks the recipient through:
 *   1. Accept / Decline;
 *   2. routing — `hidden` (a hidden shadow thread) or `merge` (show in the main chat list); and
 *   3. for a HIDDEN thread ONLY, a SECRET — a required alias to re-open it later via search, plus an
 *      optional per-chat PIN — because a hidden thread is excluded from the chat list and could
 *      otherwise never be re-entered. A `merge` thread lives in the main list, so it skips step 3.
 *
 * Resolves through `onAccept(routing, alias?, pin?)`; the container performs the actual accept +
 * bind. Pure presentation: real-mode gating + the card lifecycle live in the container.
 */

import React, { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { normalizeAlias, type RecipientRouting } from '@chat-app/crypto';

import { SheetItem, SheetModal, sheetStyles } from './action-sheet';
import { runBusy } from './async-submit';
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
  /**
   * Accept the invite with the chosen routing and, for a hidden thread, the re-open secret. The
   * choice stays local to this device. Rejecting (throwing) surfaces a generic inline failure and
   * leaves the sheet open so the recipient can retry.
   */
  onAccept: (routing: RecipientRouting, alias?: string, pin?: string) => Promise<void> | void;
  /** Decline the invite (persists no shadow data). */
  onDecline: () => void;
  /** Dismiss without choosing (e.g. backdrop tap) — treated as "decide later", not decline. */
  onClose: () => void;
}

type Step = 'ask' | 'routing' | 'secret';

/** The invite card: ask → routing → (hidden only) secret. One modal throughout. */
export function ShadowInviteRequestCard({
  visible,
  theme: t,
  peerName,
  label,
  onAccept,
  onDecline,
  onClose,
}: ShadowInviteRequestCardProps): React.JSX.Element {
  const [step, setStep] = useState<Step>('ask');
  const [alias, setAlias] = useState('');
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const aliasValid = normalizeAlias(alias) !== null;
  const showAliasError = alias.trim().length > 0 && !aliasValid;

  const reset = (): void => {
    setStep('ask');
    setAlias('');
    setPin('');
    setBusy(false);
    setError(null);
  };

  const close = (): void => {
    reset();
    onClose();
  };

  /** Run an accept attempt behind the busy gate, surfacing the real reason on failure. */
  const runAccept = (routing: RecipientRouting, withSecret: boolean): void => {
    setError(null);
    const trimmedPin = pin.trim();
    void runBusy({
      enabled: !busy,
      busy,
      setBusy,
      action: async () => {
        try {
          await onAccept(
            routing,
            withSecret ? alias.trim() : undefined,
            withSecret && trimmedPin.length > 0 ? trimmedPin : undefined,
          );
          reset();
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          setError(reason.length > 0 ? reason : 'Could not open the shadow chat. Please try again.');
        }
      },
    });
  };

  return (
    <SheetModal visible={visible} onClose={close} theme={t}>
      <View style={styles.header}>
        <Text style={[sheetStyles.sheetTitle, { color: t.text }]} numberOfLines={1}>
          {step === 'secret' ? 'Set a secret to re-open this chat' : 'Shadow chat invite'}
        </Text>
        {step !== 'secret' && (
          <Text style={[styles.subtitle, { color: t.subtext }]} numberOfLines={2}>
            {peerName}
            {label !== undefined && label.length > 0 ? ` · ${label}` : ''} wants to start a private
            shadow chat with you.
          </Text>
        )}
      </View>

      {step === 'ask' && (
        <>
          <SheetItem label="Accept" onPress={() => setStep('routing')} theme={t} />
          <SheetItem label="Decline" onPress={onDecline} theme={t} destructive />
        </>
      )}

      {step === 'routing' && (
        <>
          <Text style={[styles.hint, { color: t.subtext }]}>
            Where should this chat appear on your device?
          </Text>
          {ROUTING_OPTIONS.map((option) => (
            <SheetItem
              key={option.value}
              label={
                option.value === DEFAULT_RECIPIENT_ROUTING ? `${option.label} (recommended)` : option.label
              }
              onPress={() => {
                if (option.value === 'hidden') {
                  // Hidden ⇒ collect a re-open secret next (same modal). Merge ⇒ accept now.
                  setStep('secret');
                } else {
                  runAccept('merge', false);
                }
              }}
              theme={t}
            />
          ))}
          <SheetItem label="Back" onPress={() => setStep('ask')} theme={t} />
        </>
      )}

      {step === 'secret' && (
        <>
          <Text style={[styles.hint, { color: t.subtext }]}>
            This hidden chat won’t appear in your chat list. Choose an alias to re-open it later by
            searching, and an optional PIN to lock it.
          </Text>

          <Text style={[styles.label, { color: t.faint }]}>ALIAS</Text>
          <TextInput
            style={[styles.input, { backgroundColor: t.field, color: t.text }]}
            placeholder="/secret1"
            placeholderTextColor={t.faint}
            value={alias}
            onChangeText={(next) => {
              setAlias(next);
              setError(null);
            }}
            autoCapitalize="none"
            autoCorrect={false}
            editable={!busy}
            accessibilityLabel="Shadow chat alias"
          />
          {showAliasError && (
            <Text style={[styles.fieldError, { color: t.danger }]}>
              Must start with / and use only letters or numbers.
            </Text>
          )}

          <Text style={[styles.label, { color: t.faint, marginTop: 14 }]}>PIN (OPTIONAL)</Text>
          <TextInput
            style={[styles.input, { backgroundColor: t.field, color: t.text }]}
            placeholder="Leave blank for no PIN"
            placeholderTextColor={t.faint}
            value={pin}
            onChangeText={setPin}
            secureTextEntry
            keyboardType="number-pad"
            editable={!busy}
            accessibilityLabel="Optional per-chat PIN"
          />

          {error !== null && <Text style={[styles.fieldError, { color: t.danger }]}>{error}</Text>}

          <Pressable
            style={[styles.accept, { backgroundColor: t.brand }, (!aliasValid || busy) && styles.disabled]}
            onPress={() => {
              if (aliasValid) {
                runAccept('hidden', true);
              }
            }}
            disabled={!aliasValid || busy}
            accessibilityRole="button"
            accessibilityLabel="Accept shadow chat"
            accessibilityState={{ disabled: !aliasValid || busy, busy }}
          >
            {busy ? (
              <ActivityIndicator color={t.onBrand} />
            ) : (
              <Text style={[styles.acceptText, { color: t.onBrand }]}>Accept shadow chat</Text>
            )}
          </Pressable>
          <SheetItem label="Back" onPress={() => setStep('routing')} theme={t} />
        </>
      )}
    </SheetModal>
  );
}

const styles = StyleSheet.create({
  header: { marginBottom: 4 },
  subtitle: { fontSize: 13, marginTop: 2 },
  hint: { fontSize: 13, marginTop: 6, marginBottom: 6 },
  label: { fontSize: 11, fontWeight: '700', marginBottom: 6, letterSpacing: 0.5 },
  input: { borderRadius: 12, paddingHorizontal: 14, paddingVertical: 11, fontSize: 15 },
  fieldError: { fontSize: 12, marginTop: 6 },
  accept: { marginTop: 18, paddingVertical: 13, borderRadius: 14, alignItems: 'center' },
  disabled: { opacity: 0.45 },
  acceptText: { fontWeight: '700', fontSize: 15 },
});
