/**
 * Mobile `Conversation_Screen` (Phase 1, task 6.7; design Client Component 7: UI;
 * visual design: design/mockups screen 03).
 *
 * Presentational React Native component: renders a {@link ConversationState} produced by
 * the shared `ConversationReducer` (from `@chat-app/crypto`) and reports user intent via
 * callbacks. The conversation render contract is shared with the web `ConversationScreen`
 * (Requirement 6.7); the container owns the reducer, transport, and crypto wiring.
 *
 * Phase 2 surfaces the Wave-1 features that already exist in the shared core but were
 * previously invisible: message-gap markers (Req 2.2), reactions / edit / delete via a
 * long-press action sheet (Req 3.4), a per-conversation disappearing-message timer (Req 4.1),
 * and a safety-number verification panel (Req 1.4). Local UI state (which sheet is open,
 * the edit draft) lives here; conversation state stays in the shared reducer.
 */

import React, { useState } from 'react';
import {
  FlatList,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import type {
  ConversationState,
  MessageTarget,
  RenderableMessage,
  SafetyNumber,
} from '@chat-app/crypto';

import { avatarColor, initials, useTheme, type Theme } from './theme';

export interface ConversationScreenProps {
  state: ConversationState;
  /** Display name of the chat peer (header). */
  peerName: string;
  /** Whether the peer is currently typing (Req 5.3); shows a "typing…" header hint. */
  peerTyping?: boolean;
  /** Peer online state for opted-in presence (Req 5.2); `null` = unknown/opted-out. */
  peerOnline?: boolean | null;
  /** Peer coarse last-seen (unix ms) when offline + opted-in, else `null` (Req 5.2). */
  peerLastSeen?: number | null;
  onComposerChange: (text: string) => void;
  onSend: (options?: { viewOnce?: boolean }) => void;
  /** Back to the chats list. */
  onBack: () => void;
  /** React to a message with an emoji (Req 3.1). */
  onReact: (target: MessageTarget, emoji: string) => void;
  /** Replace a message's text (Req 3.2). */
  onEdit: (target: MessageTarget, body: string) => void;
  /** Delete (tombstone) a message (Req 3.3). */
  onDelete: (target: MessageTarget) => void;
  /** A view-once message was opened: purge it (delete-on-display) by its row id (Req 4.3). */
  onView: (id: string) => void;
  /** Set the conversation's disappearing-message timer in ms; `0` disables it (Req 4.1). */
  onSetTimer: (ttlMs: number) => void;
  /** Compute the conversation safety number, or `null` if not yet available (Req 1.1–1.3). */
  getSafetyNumber: () => Promise<SafetyNumber | null>;
}

const STATUS_LABEL: Record<RenderableMessage['status'], string> = {
  sending: '🕓',
  sent: '✓✓',
  failed: '⚠ failed',
  received: '',
  'delivery-error': '⚠ could not be decrypted',
};

/** Quick-reaction palette shown in the long-press action sheet. */
const REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🙏'];

/** Disappearing-timer presets, label → milliseconds (`0` = off). */
const TIMER_PRESETS: ReadonlyArray<{ label: string; ms: number }> = [
  { label: 'Off', ms: 0 },
  { label: '30 seconds', ms: 30_000 },
  { label: '5 minutes', ms: 5 * 60_000 },
  { label: '1 hour', ms: 60 * 60_000 },
  { label: '1 day', ms: 24 * 60 * 60_000 },
  { label: '1 week', ms: 7 * 24 * 60 * 60_000 },
];

/** Human label for an active timer (matches a preset, else a coarse fallback). */
function timerLabel(ttlMs: number): string {
  if (ttlMs <= 0) {
    return 'Off';
  }
  return TIMER_PRESETS.find((p) => p.ms === ttlMs)?.label ?? `${Math.round(ttlMs / 1000)}s`;
}

/** Coarse "last seen" phrasing from a unix-ms timestamp (already 5-min bucketed by the server). */
function relativeLastSeen(at: number): string {
  const mins = Math.max(0, Math.round((Date.now() - at) / 60000));
  if (mins < 5) {
    return 'last seen recently';
  }
  if (mins < 60) {
    return `last seen ${mins}m ago`;
  }
  const hours = Math.round(mins / 60);
  if (hours < 24) {
    return `last seen ${hours}h ago`;
  }
  return `last seen ${Math.round(hours / 24)}d ago`;
}

/**
 * The conversation-header subtitle, in priority order: typing > peer online/last-seen (opt-in
 * presence, Req 5.2) > socket connection state. `peerOnline === null` means presence is unknown
 * or the peer opted out, so we fall back to the encryption/connection line.
 */
function headerStatus(args: {
  peerTyping: boolean;
  peerOnline: boolean | null;
  peerLastSeen: number | null;
  connected: boolean;
}): string {
  if (args.peerTyping) {
    return 'typing…';
  }
  if (args.peerOnline === true) {
    return 'online';
  }
  if (args.peerOnline === false && args.peerLastSeen !== null) {
    return relativeLastSeen(args.peerLastSeen);
  }
  return args.connected ? 'Encrypted · end-to-end' : 'Connecting…';
}

export function ConversationScreen({
  state,
  peerName,
  peerTyping = false,
  peerOnline = null,
  peerLastSeen = null,
  onComposerChange,
  onSend,
  onBack,
  onReact,
  onEdit,
  onDelete,
  onView,
  onSetTimer,
  getSafetyNumber,
}: ConversationScreenProps): React.JSX.Element {
  const t = useTheme();
  const connected = state.connection === 'connected';
  const canSend = state.composer.canSend && state.webWarningAcknowledged;
  // Local composer affordance: the next message is sent view-once (Req 4.3).
  const [composeViewOnce, setComposeViewOnce] = useState(false);
  // Captured content of a view-once message being revealed (the row is purged on open).
  const [reveal, setReveal] = useState<string | null>(null);

  const send = (): void => {
    onSend(composeViewOnce ? { viewOnce: true } : undefined);
    setComposeViewOnce(false);
  };

  // Open a received view-once message: capture its text, then purge it immediately so it can
  // never be re-opened (Req 4.3). The captured text stays in the modal until dismissed.
  const revealViewOnce = (message: RenderableMessage): void => {
    setReveal(message.text ?? '');
    onView(message.id);
  };

  // Local UI state: which message the action sheet targets, the edit draft, and which
  // header panel (timer / safety) is open. None of this is conversation state.
  const [actionTarget, setActionTarget] = useState<RenderableMessage | null>(null);
  const [editDraft, setEditDraft] = useState<{ target: MessageTarget; text: string } | null>(null);
  const [timerOpen, setTimerOpen] = useState(false);
  const [safety, setSafety] = useState<{ open: boolean; value: SafetyNumber | null; loading: boolean }>(
    { open: false, value: null, loading: false },
  );

  const targetOf = (m: RenderableMessage): MessageTarget => ({ direction: m.direction, seq: m.seq });

  const openSafety = (): void => {
    setSafety({ open: true, value: null, loading: true });
    void getSafetyNumber().then((value) => setSafety({ open: true, value, loading: false }));
  };

  const submitEdit = (): void => {
    if (editDraft === null) {
      return;
    }
    const body = editDraft.text.trim();
    if (body.length > 0) {
      onEdit(editDraft.target, body);
    }
    setEditDraft(null);
  };

  return (
    <View style={[styles.screen, { backgroundColor: t.bg }]}>
      <View style={[styles.header, { backgroundColor: t.surface, borderBottomColor: t.divider }]}>
        <Pressable onPress={onBack} accessibilityRole="button" accessibilityLabel="Back" hitSlop={12}>
          <Text style={[styles.back, { color: t.brandSoft }]}>‹</Text>
        </Pressable>
        <View style={[styles.avatar, { backgroundColor: avatarColor(peerName) }]}>
          <Text style={styles.avatarText}>{initials(peerName)}</Text>
        </View>
        <View style={styles.headerBody}>
          <Text style={[styles.peerName, { color: t.text }]} numberOfLines={1}>
            {peerName}
          </Text>
          <Text
            style={[
              styles.headerStatus,
              { color: peerTyping || peerOnline === true ? (peerTyping ? t.brandSoft : t.secure) : t.faint },
            ]}
          >
            {headerStatus({ peerTyping, peerOnline, peerLastSeen, connected })}
          </Text>
        </View>
        <Pressable
          onPress={() => setTimerOpen(true)}
          accessibilityRole="button"
          accessibilityLabel="Disappearing messages"
          hitSlop={10}
          style={styles.headerAction}
        >
          <Text style={[styles.headerActionIcon, { color: state.disappearingTtlMs > 0 ? t.secure : t.faint }]}>
            ⏲
          </Text>
        </Pressable>
        <Pressable
          onPress={openSafety}
          accessibilityRole="button"
          accessibilityLabel="Verify safety number"
          hitSlop={10}
          style={styles.headerAction}
        >
          <Text style={[styles.headerActionIcon, { color: t.brandSoft }]}>🛡</Text>
        </Pressable>
      </View>

      <FlatList
        style={styles.list}
        contentContainerStyle={styles.listContent}
        data={state.messages}
        keyExtractor={(m) => `${m.direction}:${m.seq}`}
        renderItem={({ item }) => (
          <>
            {item.direction === 'in' && state.missingBefore.includes(item.seq) && (
              <View style={styles.gap}>
                <View style={[styles.gapLine, { backgroundColor: t.divider }]} />
                <Text style={[styles.gapText, { color: t.faint }]}>⚠ Messages may be missing</Text>
                <View style={[styles.gapLine, { backgroundColor: t.divider }]} />
              </View>
            )}
            <Bubble
              message={item}
              theme={t}
              onLongPress={() => setActionTarget(item)}
              onReveal={() => revealViewOnce(item)}
            />
          </>
        )}
        ListHeaderComponent={
          // One quiet reassurance line, then messages own the screen (UX directive:
          // security is felt, not displayed — no amber warning boxes).
          <View>
            <Text style={[styles.notice, { color: t.faint }]}>🔒 Messages are end-to-end encrypted</Text>
            {state.disappearingTtlMs > 0 && (
              <Text style={[styles.notice, { color: t.secure }]}>
                ⏲ Disappearing messages: {timerLabel(state.disappearingTtlMs)}
              </Text>
            )}
          </View>
        }
      />

      <View style={[styles.composer, { backgroundColor: t.surface, borderTopColor: t.divider }]}>
        <Pressable
          onPress={() => setComposeViewOnce((v) => !v)}
          accessibilityRole="button"
          accessibilityLabel="View once"
          accessibilityState={{ selected: composeViewOnce }}
          hitSlop={8}
          style={[
            styles.viewOnceToggle,
            { borderColor: composeViewOnce ? t.brand : t.divider, backgroundColor: composeViewOnce ? t.brandFill : 'transparent' },
          ]}
        >
          <Text style={[styles.viewOnceToggleIcon, { color: composeViewOnce ? t.brand : t.faint }]}>👁</Text>
        </Pressable>
        <TextInput
          style={[styles.input, { backgroundColor: t.field, color: t.text }]}
          value={state.composer.text}
          placeholder={composeViewOnce ? 'View-once message…' : 'Message…'}
          placeholderTextColor={t.faint}
          onChangeText={onComposerChange}
          accessibilityLabel="Message"
        />
        <Pressable
          style={[styles.sendButton, { backgroundColor: t.brand }, !canSend && styles.sendDisabled]}
          disabled={!canSend}
          onPress={send}
          accessibilityRole="button"
          accessibilityLabel="Send"
        >
          <Text style={[styles.sendText, { color: t.onBrand }]}>➤</Text>
        </Pressable>
      </View>

      {/* Long-press action sheet: react / edit / delete (Req 3.4). */}
      <SheetModal visible={actionTarget !== null} onClose={() => setActionTarget(null)} theme={t}>
        {actionTarget !== null && (
          <>
            <View style={styles.reactionRow}>
              {REACTIONS.map((emoji) => (
                <Pressable
                  key={emoji}
                  style={styles.reactionPick}
                  accessibilityRole="button"
                  accessibilityLabel={`React ${emoji}`}
                  onPress={() => {
                    onReact(targetOf(actionTarget), emoji);
                    setActionTarget(null);
                  }}
                >
                  <Text style={styles.reactionPickText}>{emoji}</Text>
                </Pressable>
              ))}
            </View>
            {actionTarget.direction === 'out' && actionTarget.deleted !== true && (
              <SheetItem
                label="Edit"
                theme={t}
                onPress={() => {
                  setEditDraft({ target: targetOf(actionTarget), text: actionTarget.text ?? '' });
                  setActionTarget(null);
                }}
              />
            )}
            {actionTarget.deleted !== true && (
              <SheetItem
                label="Delete"
                destructive
                theme={t}
                onPress={() => {
                  onDelete(targetOf(actionTarget));
                  setActionTarget(null);
                }}
              />
            )}
            <SheetItem label="Cancel" theme={t} onPress={() => setActionTarget(null)} />
          </>
        )}
      </SheetModal>

      {/* Edit draft (Req 3.2). */}
      <SheetModal visible={editDraft !== null} onClose={() => setEditDraft(null)} theme={t}>
        {editDraft !== null && (
          <>
            <Text style={[styles.sheetTitle, { color: t.text }]}>Edit message</Text>
            <TextInput
              style={[styles.editInput, { backgroundColor: t.field, color: t.text }]}
              value={editDraft.text}
              onChangeText={(text) => setEditDraft({ ...editDraft, text })}
              accessibilityLabel="Edit message text"
              multiline
              autoFocus
            />
            <SheetItem label="Save" theme={t} onPress={submitEdit} />
            <SheetItem label="Cancel" theme={t} onPress={() => setEditDraft(null)} />
          </>
        )}
      </SheetModal>

      {/* Disappearing-message timer (Req 4.1). */}
      <SheetModal visible={timerOpen} onClose={() => setTimerOpen(false)} theme={t}>
        <Text style={[styles.sheetTitle, { color: t.text }]}>Disappearing messages</Text>
        <Text style={[styles.sheetHint, { color: t.faint }]}>
          New messages disappear from both devices after the timer.
        </Text>
        {TIMER_PRESETS.map((preset) => {
          const active = state.disappearingTtlMs === preset.ms;
          return (
            <SheetItem
              key={preset.label}
              label={active ? `✓ ${preset.label}` : preset.label}
              theme={t}
              onPress={() => {
                onSetTimer(preset.ms);
                setTimerOpen(false);
              }}
            />
          );
        })}
      </SheetModal>

      {/* Safety-number verification (Req 1.4). */}
      <SheetModal visible={safety.open} onClose={() => setSafety({ ...safety, open: false })} theme={t}>
        <Text style={[styles.sheetTitle, { color: t.text }]}>Verify safety number</Text>
        <Text style={[styles.sheetHint, { color: t.faint }]}>
          Compare these digits with {peerName} in person or over a trusted channel. If they match, no
          one is intercepting your conversation.
        </Text>
        {safety.loading ? (
          <Text style={[styles.safetyDigits, { color: t.faint }]}>Computing…</Text>
        ) : safety.value !== null ? (
          <Text style={[styles.safetyDigits, { color: t.text }]} selectable>
            {safety.value.formatted}
          </Text>
        ) : (
          <Text style={[styles.safetyDigits, { color: t.faint }]}>
            Not available yet — send or receive a message first.
          </Text>
        )}
        <SheetItem label="Done" theme={t} onPress={() => setSafety({ ...safety, open: false })} />
      </SheetModal>

      {/* View-once reveal (Req 4.3): the message is already purged; this shows its captured text once. */}
      <SheetModal visible={reveal !== null} onClose={() => setReveal(null)} theme={t}>
        <Text style={[styles.sheetTitle, { color: t.text }]}>👁 View once</Text>
        <Text style={[styles.sheetHint, { color: t.faint }]}>
          This message disappears when you close it and can’t be opened again.
        </Text>
        <Text style={[styles.viewOnceBody, { color: t.text }]} selectable>
          {reveal}
        </Text>
        <SheetItem label="Close" theme={t} onPress={() => setReveal(null)} />
      </SheetModal>
    </View>
  );
}

/** A bottom-sheet-style modal used by every action panel. */
function SheetModal({
  visible,
  onClose,
  theme: t,
  children,
}: {
  visible: boolean;
  onClose: () => void;
  theme: Theme;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose} accessibilityLabel="Dismiss">
        <Pressable style={[styles.sheet, { backgroundColor: t.surface }]} onPress={() => undefined}>
          <ScrollView>{children}</ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

/** A single tappable row inside a {@link SheetModal}. */
function SheetItem({
  label,
  onPress,
  theme: t,
  destructive,
}: {
  label: string;
  onPress: () => void;
  theme: Theme;
  destructive?: boolean;
}): React.JSX.Element {
  return (
    <Pressable
      style={[styles.sheetItem, { borderTopColor: t.divider }]}
      onPress={onPress}
      accessibilityRole="button"
    >
      <Text style={[styles.sheetItemText, { color: destructive === true ? t.danger : t.brandSoft }]}>
        {label}
      </Text>
    </Pressable>
  );
}

function Bubble({
  message,
  theme: t,
  onLongPress,
  onReveal,
}: {
  message: RenderableMessage;
  theme: Theme;
  onLongPress: () => void;
  onReveal: () => void;
}): React.JSX.Element {
  const outbound = message.direction === 'out';
  const isError = message.status === 'delivery-error' || message.status === 'failed';
  const statusLabel = STATUS_LABEL[message.status];
  // A received view-once message is gated behind "tap to view" until opened (Req 4.3).
  const gated = message.viewOnce === true && !outbound && message.deleted !== true && message.text !== null;
  const body =
    message.deleted === true
      ? '🚫 message deleted'
      : gated
        ? '👁 Tap to view · disappears after viewing'
        : message.text === null
          ? '⚠ message unavailable'
          : message.text;
  const muted = message.deleted === true || message.text === null;
  return (
    <Pressable
      style={[styles.bubbleWrap, { alignSelf: outbound ? 'flex-end' : 'flex-start' }]}
      onPress={gated ? onReveal : undefined}
      onLongPress={message.deleted === true || gated ? undefined : onLongPress}
      delayLongPress={250}
      accessibilityRole="button"
      accessibilityLabel={gated ? 'View-once message, tap to view' : `Message: ${typeof body === 'string' ? body : ''}`}
    >
      <View
        style={[
          styles.bubble,
          outbound
            ? { backgroundColor: t.brand, opacity: message.status === 'sending' ? 0.55 : 1 }
            : { backgroundColor: t.bubbleIn, borderWidth: 1, borderColor: t.divider },
          gated && { borderStyle: 'dashed', borderWidth: 1, borderColor: t.brandSoft },
        ]}
      >
        <Text
          style={[
            styles.bubbleText,
            { color: outbound ? t.onBrand : t.text },
            (muted || gated) && styles.bubbleTextMissing,
          ]}
        >
          {body}
        </Text>
        {message.viewOnce === true && outbound && message.deleted !== true && (
          <Text style={[styles.editedTag, { color: t.onBrand }]}>👁 view once</Text>
        )}
        {message.edited === true && message.deleted !== true && (
          <Text style={[styles.editedTag, { color: outbound ? t.onBrand : t.faint }]}>edited</Text>
        )}
      </View>
      {message.reactions !== undefined && message.reactions.length > 0 && (
        <View style={[styles.reactionsBar, { alignSelf: outbound ? 'flex-end' : 'flex-start' }]}>
          {message.reactions.map((emoji) => (
            <View key={emoji} style={[styles.reactionChip, { backgroundColor: t.field, borderColor: t.divider }]}>
              <Text style={styles.reactionChipText}>{emoji}</Text>
            </View>
          ))}
        </View>
      )}
      {statusLabel.length > 0 && (
        <Text style={[styles.status, { color: isError ? t.danger : t.faint }]}>
          {statusLabel}
          {message.error !== undefined ? ` · ${message.error}` : ''}
        </Text>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    gap: 10,
  },
  back: { fontSize: 26, fontWeight: '600', paddingRight: 2 },
  avatar: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  avatarText: { color: '#fff', fontSize: 14, fontWeight: '700' },
  headerBody: { flex: 1 },
  peerName: { fontSize: 16, fontWeight: '700' },
  headerStatus: { fontSize: 11, marginTop: 2 },
  headerAction: { paddingHorizontal: 4, paddingVertical: 2 },
  headerActionIcon: { fontSize: 18 },
  list: { flex: 1 },
  listContent: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 8 },
  notice: { fontSize: 11, textAlign: 'center', marginBottom: 8, marginTop: 4 },
  gap: { flexDirection: 'row', alignItems: 'center', gap: 8, marginVertical: 8 },
  gapLine: { flex: 1, height: 1 },
  gapText: { fontSize: 10, fontWeight: '600' },
  bubbleWrap: { maxWidth: '80%', marginVertical: 3 },
  bubble: { borderRadius: 18, paddingHorizontal: 14, paddingVertical: 9 },
  bubbleText: { fontSize: 15 },
  bubbleTextMissing: { fontStyle: 'italic' },
  editedTag: { fontSize: 9, marginTop: 2, opacity: 0.8 },
  reactionsBar: { flexDirection: 'row', gap: 4, marginTop: 3 },
  reactionChip: { borderRadius: 10, borderWidth: 1, paddingHorizontal: 6, paddingVertical: 1 },
  reactionChipText: { fontSize: 12 },
  status: { fontSize: 10, marginTop: 2, alignSelf: 'flex-end' },
  composer: { flexDirection: 'row', alignItems: 'center', padding: 12, borderTopWidth: 1, gap: 8 },
  viewOnceToggle: {
    width: 38,
    height: 38,
    borderRadius: 19,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  viewOnceToggleIcon: { fontSize: 16 },
  viewOnceBody: { fontSize: 16, lineHeight: 23, marginVertical: 14 },
  input: { flex: 1, borderRadius: 20, paddingHorizontal: 16, paddingVertical: 10, fontSize: 15 },
  sendButton: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
  sendDisabled: { opacity: 0.4 },
  sendText: { fontSize: 16 },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'flex-end' },
  sheet: {
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    paddingHorizontal: 20,
    paddingTop: 16,
    paddingBottom: 28,
    maxHeight: '70%',
  },
  sheetTitle: { fontSize: 16, fontWeight: '700', marginBottom: 6 },
  sheetHint: { fontSize: 12, marginBottom: 12, lineHeight: 17 },
  sheetItem: { paddingVertical: 14, borderTopWidth: 1 },
  sheetItemText: { fontSize: 15, fontWeight: '600', textAlign: 'center' },
  reactionRow: { flexDirection: 'row', justifyContent: 'space-around', paddingVertical: 8 },
  reactionPick: { padding: 6 },
  reactionPickText: { fontSize: 26 },
  editInput: { borderRadius: 12, paddingHorizontal: 14, paddingVertical: 10, fontSize: 15, minHeight: 64 },
  safetyDigits: {
    fontSize: 17,
    letterSpacing: 1,
    lineHeight: 28,
    textAlign: 'center',
    marginVertical: 16,
    fontVariant: ['tabular-nums'],
  },
});
