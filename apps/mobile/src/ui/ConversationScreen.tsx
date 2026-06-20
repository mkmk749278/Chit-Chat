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

import React, { useMemo, useState } from 'react';
import { FlatList, Modal, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import type {
  ConversationState,
  MessageTarget,
  RenderableMessage,
  SafetyNumber,
} from '@chat-app/crypto';

import { SheetItem, SheetModal } from './action-sheet';
import { runBusy } from './async-submit';
import { CONVERSATION_ACTIONS, type ConversationActionKey } from './conversation-actions';
import { ContactProfileScreen } from './ContactProfileScreen';
import { TIMER_PRESETS, timerLabel } from './disappearing';
import { Icon } from './icons';
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
  /**
   * Per-session in-chat verification status for this peer (Signature Feature 2, §4.3):
   * `requested` (we asked, awaiting), `incoming` (they asked us to answer), `verified` / `unverified`.
   */
  verification?: 'none' | 'requested' | 'incoming' | 'verified' | 'unverified';
  /** Start an identity verification with the peer (§4.2). */
  onRequestVerification?: () => void;
  /** Answer the peer's verification with the normal or duress code (§4.2, §4.3). */
  onRespondVerification?: (kind: 'normal' | 'duress') => void;
  /** Whether this chat is currently hidden (Signature Feature 1, §3). */
  isHidden?: boolean;
  /** Mark this chat hidden behind `secret` (§3.1). May hash asynchronously (Requirement 1.3). */
  onHideChat?: (secret: string) => void | Promise<void>;
  /** Remove this chat's hidden status (§3.3). May resolve asynchronously (Requirement 1.3). */
  onUnhideChat?: () => void | Promise<void>;
}

const STATUS_LABEL: Record<RenderableMessage['status'], string> = {
  sending: '',
  sent: '',
  failed: 'failed',
  received: '',
  'delivery-error': 'could not be decrypted',
};

/** Quick-reaction palette shown in the long-press action sheet. */
const REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🙏'];

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

/** Maximum gap between two same-direction messages that still groups them (P2/P3, Req 3.8). */
const GROUP_WINDOW_MS = 5 * 60_000;
const MS_PER_DAY = 24 * 60 * 60_000;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

/** A finite `createdAt`, or `0` for absent/non-finite (mirrors the reducer's ordering key). */
function msgTime(m: RenderableMessage): number {
  return typeof m.createdAt === 'number' && Number.isFinite(m.createdAt) ? m.createdAt : 0;
}

/** Whether a message carries a usable `createdAt` for time/day rendering. */
function hasTime(m: RenderableMessage): boolean {
  return typeof m.createdAt === 'number' && Number.isFinite(m.createdAt);
}

/** Local-time `HH:mm` from a unix-ms timestamp; empty when absent/non-finite (Req 3.7). */
function timeLabel(ms?: number): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) {
    return '';
  }
  const d = new Date(ms);
  return `${`${d.getHours()}`.padStart(2, '0')}:${`${d.getMinutes()}`.padStart(2, '0')}`;
}

/** Local midnight (unix-ms) for the calendar day containing `ms`. */
function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** A day-separator label: "Today" / "Yesterday" / "12 Jun" (+ year for other years) (Req 3.6). */
function dayLabel(ms: number, now: number = Date.now()): string {
  const day = startOfDay(ms);
  const today = startOfDay(now);
  if (day === today) {
    return 'Today';
  }
  if (day === today - MS_PER_DAY) {
    return 'Yesterday';
  }
  const d = new Date(ms);
  const base = `${d.getDate()} ${MONTHS[d.getMonth()]}`;
  return d.getFullYear() === new Date(now).getFullYear() ? base : `${base} ${d.getFullYear()}`;
}

/** A rendered message decorated with its day-separator + consecutive-grouping flags (Req 3.6, 3.8). */
interface DecoratedMessage {
  message: RenderableMessage;
  /** Show a day-separator pill above this message (calendar day changed vs. the older neighbour). */
  showDay: boolean;
  /** The day-separator text, when `showDay`. */
  dayText: string;
  /** First message of a same-direction group: gets extra top spacing. */
  isHead: boolean;
  /** Last message of a same-direction group: gets the single tail (asymmetric corner). */
  isTail: boolean;
}

/** Whether two messages fall on different calendar days (both must carry a usable `createdAt`). */
function differentDay(a: RenderableMessage, b: RenderableMessage): boolean {
  return hasTime(a) && hasTime(b) && startOfDay(msgTime(a)) !== startOfDay(msgTime(b));
}

/**
 * Decorate the chronological message list (oldest → newest) with day-separator and grouping flags
 * (Req 3.6, 3.8). A day separator is shown above the first message of each calendar day; a
 * same-direction run within {@link GROUP_WINDOW_MS} (and within one day) forms a group whose first
 * message is the head (extra spacing) and whose last message is the tail (single asymmetric corner).
 */
function decorateMessages(messages: readonly RenderableMessage[]): DecoratedMessage[] {
  return messages.map((message, i) => {
    const prev = messages[i - 1]; // chronologically older
    const next = messages[i + 1]; // chronologically newer
    const t = msgTime(message);

    const showDay =
      hasTime(message) && (prev === undefined || !hasTime(prev) || differentDay(prev, message));

    const brokenFromPrev =
      prev === undefined ||
      prev.direction !== message.direction ||
      t - msgTime(prev) > GROUP_WINDOW_MS ||
      showDay;
    const brokenToNext =
      next === undefined ||
      next.direction !== message.direction ||
      msgTime(next) - t > GROUP_WINDOW_MS ||
      differentDay(next, message);

    return {
      message,
      showDay,
      dayText: showDay ? dayLabel(t) : '',
      isHead: brokenFromPrev,
      isTail: brokenToNext,
    };
  });
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
  verification = 'none',
  onRequestVerification,
  onRespondVerification,
  isHidden = false,
  onHideChat,
  onUnhideChat,
}: ConversationScreenProps): React.JSX.Element {
  const t = useTheme();
  const connected = state.connection === 'connected';
  const canSend = state.composer.canSend && state.webWarningAcknowledged;
  // Decorate the chronological list with day-separator + grouping flags, then reverse it for the
  // `inverted` (bottom-anchored) FlatList so the newest message shows without manual scroll (Req 3.5).
  const decorated = useMemo(() => decorateMessages(state.messages), [state.messages]);
  const invertedData = useMemo(() => [...decorated].reverse(), [decorated]);
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
  const [verifyOpen, setVerifyOpen] = useState(false);
  const [hideOpen, setHideOpen] = useState(false);
  const [hideSecret, setHideSecret] = useState('');
  // True while the hide / unhide hash + vault mutation is in flight (Requirement 1.3).
  const [hideBusy, setHideBusy] = useState(false);
  // P3 header redesign: the overflow (⋮) menu and the Contact/Profile overlay are local UI only —
  // they re-route the EXISTING action callbacks, so ConversationScreenProps is unchanged (Req 3.1–3.4).
  const [overflowOpen, setOverflowOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);

  const closeHide = (): void => {
    if (hideBusy) {
      return;
    }
    setHideOpen(false);
    setHideSecret('');
  };
  const submitHide = (): void => {
    const secret = hideSecret.trim();
    void runBusy({
      enabled: secret.length > 0,
      busy: hideBusy,
      setBusy: setHideBusy,
      action: async () => {
        await onHideChat?.(secret);
        setHideSecret('');
        setHideOpen(false);
      },
    });
  };
  const submitUnhide = (): void => {
    void runBusy({
      enabled: true,
      busy: hideBusy,
      setBusy: setHideBusy,
      action: async () => {
        await onUnhideChat?.();
        setHideOpen(false);
      },
    });
  };

  const targetOf = (m: RenderableMessage): MessageTarget => ({ direction: m.direction, seq: m.seq });

  const openSafety = (): void => {
    setSafety({ open: true, value: null, loading: true });
    void getSafetyNumber().then((value) => setSafety({ open: true, value, loading: false }));
  };

  /**
   * Route an action chosen from the overflow menu or the Contact/Profile screen to the EXISTING
   * action sheet for that flow (Req 3.3, 3.4). This reuses the same sheets and the same callbacks the
   * removed header icons used — only the entry point changed.
   */
  const openAction = (key: ConversationActionKey): void => {
    setOverflowOpen(false);
    setProfileOpen(false);
    switch (key) {
      case 'disappearing':
        setTimerOpen(true);
        break;
      case 'verify':
        setVerifyOpen(true);
        break;
      case 'safety':
        openSafety();
        break;
      case 'hide':
        setHideOpen(true);
        break;
    }
  };

  /** Semantic icon for each overflow menu row. */
  const overflowIcon: Record<ConversationActionKey, 'timer' | 'verified' | 'shield' | 'hide'> = {
    disappearing: 'timer',
    verify: 'verified',
    safety: 'shield',
    hide: 'hide',
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
        <Pressable
          onPress={onBack}
          accessibilityRole="button"
          accessibilityLabel="Back"
          hitSlop={12}
          style={styles.headerBack}
        >
          <Icon name="back" size={22} color={t.brandSoft} />
        </Pressable>

        {/* Tappable avatar + name + concise status → opens the Contact/Profile screen (Req 3.1, 3.2). */}
        <Pressable
          style={styles.headerIdentity}
          onPress={() => setProfileOpen(true)}
          accessibilityRole="button"
          accessibilityLabel={`${peerName}, open profile`}
        >
          <View style={[styles.avatar, { backgroundColor: avatarColor(peerName) }]}>
            <Text style={styles.avatarText}>{initials(peerName)}</Text>
          </View>
          <View style={styles.headerBody}>
            <View style={styles.nameRow}>
              <Text style={[styles.peerName, { color: t.text }]} numberOfLines={1}>
                {peerName}
              </Text>
              {/* Surface a verification prompt/badge for incoming or unverified peers (Req 3.3). */}
              {(verification === 'incoming' || verification === 'unverified') && (
                <View
                  style={[
                    styles.verifyBadge,
                    { backgroundColor: verification === 'unverified' ? t.dangerSoft : t.brandFill },
                  ]}
                >
                  <Icon
                    name="verified"
                    size={11}
                    color={verification === 'unverified' ? t.danger : t.brandSoft}
                  />
                  <Text
                    style={[
                      styles.verifyBadgeText,
                      { color: verification === 'unverified' ? t.danger : t.brandSoft },
                    ]}
                  >
                    {verification === 'unverified' ? 'Unverified' : 'Verify'}
                  </Text>
                </View>
              )}
            </View>
            <Text
              style={[
                styles.headerStatus,
                { color: peerTyping || peerOnline === true ? (peerTyping ? t.brandSoft : t.secure) : t.faint },
              ]}
              numberOfLines={1}
            >
              {headerStatus({ peerTyping, peerOnline, peerLastSeen, connected })}
            </Text>
          </View>
        </Pressable>

        {/* The single header action: an overflow (⋮) menu holding the four moved actions (Req 3.3). */}
        <Pressable
          onPress={() => setOverflowOpen((v) => !v)}
          accessibilityRole="button"
          accessibilityLabel="More options"
          hitSlop={12}
          style={styles.overflowBtn}
        >
          <Icon name="more-vert" size={22} color={t.subtext} />
        </Pressable>

        {overflowOpen && (
          <>
            <Pressable
              style={styles.overflowScrim}
              onPress={() => setOverflowOpen(false)}
              accessibilityLabel="Dismiss menu"
            />
            <View style={[styles.overflowMenu, { backgroundColor: t.surface, borderColor: t.divider }]}>
              {CONVERSATION_ACTIONS.map((action, idx) => {
                const destructive = action.key === 'hide';
                return (
                  <Pressable
                    key={action.key}
                    onPress={() => openAction(action.key)}
                    style={[
                      styles.overflowItem,
                      idx > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: t.divider },
                    ]}
                    accessibilityRole="button"
                    accessibilityLabel={action.label}
                  >
                    <Icon name={overflowIcon[action.key]} size={18} color={destructive ? t.danger : t.subtext} />
                    <Text style={[styles.overflowText, { color: destructive ? t.danger : t.text }]}>
                      {destructive && isHidden ? 'Unhide chat' : action.label}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          </>
        )}
      </View>

      <FlatList
        style={styles.list}
        contentContainerStyle={styles.listContent}
        data={invertedData}
        inverted
        keyExtractor={(d) => `${d.message.direction}:${d.message.seq}`}
        renderItem={({ item }) => {
          const m = item.message;
          return (
            <View>
              {/* Day separator above the first message of each calendar day (Req 3.6). */}
              {item.showDay && (
                <View style={styles.daySeparator}>
                  <View style={[styles.dayPill, { backgroundColor: t.field }]}>
                    <Text style={[styles.dayPillText, { color: t.faint }]}>{item.dayText}</Text>
                  </View>
                </View>
              )}
              {/* Existing inbound gap marker (Req 2.2) — unchanged, still driven by inbound seq. */}
              {m.direction === 'in' && state.missingBefore.includes(m.seq) && (
                <View style={styles.gap}>
                  <View style={[styles.gapLine, { backgroundColor: t.divider }]} />
                  <Text style={[styles.gapText, { color: t.faint }]}>⚠ Messages may be missing</Text>
                  <View style={[styles.gapLine, { backgroundColor: t.divider }]} />
                </View>
              )}
              <Bubble
                message={m}
                theme={t}
                time={timeLabel(m.createdAt)}
                isHead={item.isHead}
                isTail={item.isTail}
                onLongPress={() => setActionTarget(m)}
                onReveal={() => revealViewOnce(m)}
              />
            </View>
          );
        }}
        ListFooterComponent={
          // With an inverted list the footer renders at the TOP (oldest end): one quiet reassurance
          // line, then messages own the screen (UX directive: security is felt, not displayed).
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
          <Icon name="send" size={20} color={t.onBrand} />
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

      {/* In-chat identity verification — rotating TOTP + duress code (Signature Feature 2, §4). */}
      <SheetModal visible={verifyOpen} onClose={() => setVerifyOpen(false)} theme={t}>
        <Text style={[styles.sheetTitle, { color: t.text }]}>Verify identity</Text>
        {verification === 'incoming' ? (
          <>
            <Text style={[styles.sheetHint, { color: t.faint }]}>
              {peerName} asked to confirm it’s really you. Send your rotating code to verify.
            </Text>
            <SheetItem
              label="Send my code"
              theme={t}
              onPress={() => {
                onRespondVerification?.('normal');
                setVerifyOpen(false);
              }}
            />
            {/* Duress: looks identical to a normal send, but silently alerts a trusted contact (§4.3). */}
            <SheetItem
              label="Send under duress"
              theme={t}
              destructive
              onPress={() => {
                onRespondVerification?.('duress');
                setVerifyOpen(false);
              }}
            />
          </>
        ) : verification === 'verified' ? (
          <Text style={[styles.sheetHint, { color: t.secure }]}>
            Verified ✓ — {peerName}’s identity is confirmed for this session.
          </Text>
        ) : verification === 'requested' ? (
          <Text style={[styles.sheetHint, { color: t.faint }]}>
            Waiting for {peerName} to respond with their rotating code…
          </Text>
        ) : (
          <>
            <Text style={[styles.sheetHint, { color: t.faint }]}>
              Confirm the human at {peerName}’s device with a code that changes every 60 seconds and
              can’t be replayed. {verification === 'unverified' ? 'Last attempt did not match.' : ''}
            </Text>
            <SheetItem
              label="Request verification"
              theme={t}
              onPress={() => {
                onRequestVerification?.();
                setVerifyOpen(false);
              }}
            />
          </>
        )}
        <SheetItem label="Close" theme={t} onPress={() => setVerifyOpen(false)} />
      </SheetModal>

      {/* Hidden chat (Signature Feature 1, §3): set/clear a per-chat unlock secret. */}
      <SheetModal visible={hideOpen} onClose={closeHide} theme={t}>
        <Text style={[styles.sheetTitle, { color: t.text }]}>Hidden chat</Text>
        {isHidden ? (
          <>
            <Text style={[styles.sheetHint, { color: t.faint }]}>
              This chat is hidden. It won’t appear in your list — reveal it by typing its secret in
              the search bar. You can unhide it here.
            </Text>
            <SheetItem
              label="Unhide this chat"
              theme={t}
              busy={hideBusy}
              disabled={hideBusy}
              onPress={submitUnhide}
            />
          </>
        ) : (
          <>
            <Text style={[styles.sheetHint, { color: t.faint }]}>
              Hide this chat behind a secret. It disappears from your list; type the secret in the
              search bar to reveal it. There is no recovery if you forget it.
            </Text>
            <TextInput
              style={[styles.editInput, { color: t.text, borderColor: t.divider }]}
              value={hideSecret}
              onChangeText={setHideSecret}
              placeholder="Secret"
              placeholderTextColor={t.faint}
              secureTextEntry
              editable={!hideBusy}
              autoFocus
            />
            <SheetItem
              label="Hide this chat"
              theme={t}
              busy={hideBusy}
              disabled={hideBusy || hideSecret.trim().length === 0}
              onPress={submitHide}
            />
          </>
        )}
        <SheetItem label="Cancel" theme={t} disabled={hideBusy} onPress={closeHide} />
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

      {/* Contact/Profile overlay (Req 3.2, 3.4): opened by tapping the header avatar/name. It is
          presentational and routes each action back through openAction → the EXISTING sheets above,
          so no callback or sheet logic is duplicated. */}
      <Modal
        visible={profileOpen}
        animationType="slide"
        onRequestClose={() => setProfileOpen(false)}
        presentationStyle="fullScreen"
      >
        <ContactProfileScreen
          peerName={peerName}
          peerOnline={peerOnline}
          peerLastSeen={peerLastSeen}
          verification={verification}
          disappearingTtlMs={state.disappearingTtlMs}
          isHidden={isHidden}
          onBack={() => setProfileOpen(false)}
          onSelectAction={openAction}
        />
      </Modal>
    </View>
  );
}

/** A bottom-sheet-style modal used by every action panel. */
function Bubble({
  message,
  theme: t,
  time,
  isHead = true,
  isTail = true,
  onLongPress,
  onReveal,
}: {
  message: RenderableMessage;
  theme: Theme;
  /** `HH:mm` label shown in the bubble footer (Req 3.7); empty when no timestamp. */
  time?: string;
  /** First message of a same-direction group: extra top spacing (Req 3.8). */
  isHead?: boolean;
  /** Last message of a same-direction group: the single tail / asymmetric corner (Req 3.8). */
  isTail?: boolean;
  onLongPress: () => void;
  onReveal: () => void;
}): React.JSX.Element {
  const outbound = message.direction === 'out';
  const isError = message.status === 'delivery-error' || message.status === 'failed';
  const statusLabel = STATUS_LABEL[message.status];
  // Status clock/checks become vector icons (Req 3.9); failed/delivery-error keep a short text label.
  const showStatusIcon =
    message.status === 'sending' || message.status === 'sent' || message.status === 'failed';
  const statusIconName =
    message.status === 'sending' ? 'status-sending' : message.status === 'sent' ? 'status-sent' : 'status-failed';
  const statusIconColor = message.status === 'sent' ? (outbound ? t.onBrand : t.faint) : isError ? t.danger : t.faint;
  const timeText = time ?? '';
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
      style={[
        styles.bubbleWrap,
        { alignSelf: outbound ? 'flex-end' : 'flex-start', marginTop: isHead ? 8 : 2 },
      ]}
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
          // Single tail: only the last bubble of a group carries the asymmetric corner (Req 3.8).
          isTail && (outbound ? styles.tailOut : styles.tailIn),
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
      {/* Footer: per-message time label (Req 3.7) alongside the status icon/label (Req 3.9). */}
      {(timeText.length > 0 || showStatusIcon || statusLabel.length > 0) && (
        <View style={[styles.footer, { alignSelf: outbound ? 'flex-end' : 'flex-start' }]}>
          {timeText.length > 0 && <Text style={[styles.timeLabel, { color: t.faint }]}>{timeText}</Text>}
          {showStatusIcon && (
            <Icon name={statusIconName} size={13} color={statusIconColor} accessibilityLabel={message.status} />
          )}
          {statusLabel.length > 0 && (
            <Text style={[styles.status, { color: isError ? t.danger : t.faint }]}>
              {statusLabel}
              {message.error !== undefined ? ` · ${message.error}` : ''}
            </Text>
          )}
        </View>
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
    gap: 8,
  },
  headerBack: { paddingRight: 2 },
  headerIdentity: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 10 },
  avatar: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  avatarText: { color: '#fff', fontSize: 14, fontWeight: '700' },
  headerBody: { flex: 1 },
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  peerName: { fontSize: 16, fontWeight: '700', flexShrink: 1 },
  headerStatus: { fontSize: 11, marginTop: 2 },
  verifyBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: 999,
  },
  verifyBadgeText: { fontSize: 10, fontWeight: '600' },
  overflowBtn: { padding: 4 },
  overflowScrim: { position: 'absolute', top: 0, left: 0, right: 0, bottom: -2000, zIndex: 5 },
  overflowMenu: {
    position: 'absolute',
    top: 54,
    right: 12,
    minWidth: 210,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    paddingVertical: 4,
    zIndex: 10,
    elevation: 6,
    shadowColor: '#000',
    shadowOpacity: 0.12,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
  },
  overflowItem: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 13 },
  overflowText: { fontSize: 15 },
  list: { flex: 1 },
  listContent: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 8 },
  notice: { fontSize: 11, textAlign: 'center', marginBottom: 8, marginTop: 4 },
  gap: { flexDirection: 'row', alignItems: 'center', gap: 8, marginVertical: 8 },
  gapLine: { flex: 1, height: 1 },
  gapText: { fontSize: 10, fontWeight: '600' },
  daySeparator: { alignItems: 'center', marginVertical: 10 },
  dayPill: { borderRadius: 999, paddingHorizontal: 12, paddingVertical: 4 },
  dayPillText: { fontSize: 11, fontWeight: '600' },
  bubbleWrap: { maxWidth: '80%', marginVertical: 3 },
  bubble: { borderRadius: 18, paddingHorizontal: 14, paddingVertical: 9 },
  tailOut: { borderBottomRightRadius: 5 },
  tailIn: { borderBottomLeftRadius: 5 },
  bubbleText: { fontSize: 15 },
  bubbleTextMissing: { fontStyle: 'italic' },
  editedTag: { fontSize: 9, marginTop: 2, opacity: 0.8 },
  reactionsBar: { flexDirection: 'row', gap: 4, marginTop: 3 },
  reactionChip: { borderRadius: 10, borderWidth: 1, paddingHorizontal: 6, paddingVertical: 1 },
  reactionChipText: { fontSize: 12 },
  footer: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 2 },
  timeLabel: { fontSize: 10 },
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
  sheetTitle: { fontSize: 16, fontWeight: '700', marginBottom: 6 },
  sheetHint: { fontSize: 12, marginBottom: 12, lineHeight: 17 },
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
