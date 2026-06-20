/**
 * MOCKUP — Redesigned Conversation screen (P3 header declutter + P2 ordering).
 *
 * What this demo shows from the design:
 *  - P3: a clean header — back chevron · tappable circular avatar (initials) ·
 *    name + a single concise status line · ONE ⋮ overflow button. The old row of
 *    five emoji icons (timer/safety/verify/hide) is gone; those actions now live
 *    in the ⋮ overflow menu and the Contact/Profile screen.
 *  - P2: the message list is ordered by `createdAt` (wall-clock time), NOT by the
 *    per-direction `seq`. The sample data below is deliberately constructed so that
 *    ordering by `seq` alone would look JUMBLED, but ordering by `createdAt` reads
 *    as a correct back-and-forth (see SAMPLE_MESSAGES comment).
 *  - Day separator pills ("Today" / "Yesterday"), per-message HH:mm time labels,
 *    status ticks (✓ / ✓✓) on outbound, consecutive-sender grouping (tighter
 *    spacing + a single tail on the last bubble of a run), one reaction, one
 *    "edited" tag, and one "message deleted" placeholder.
 *
 * Hard-coded sample data only. No crypto, no transport, no real wiring.
 */

import React, { useMemo, useRef, useState } from 'react';
import {
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  type ListRenderItemInfo,
} from 'react-native';

import { Icon } from './Icon.mockup';
import {
  avatarColor,
  initials,
  radius,
  spacing,
  type,
  useTheme,
  type Theme,
} from './theme.mockup';

type Direction = 'in' | 'out';
type Status = 'sending' | 'sent' | 'received' | 'failed';

interface MockMessage {
  id: string;
  direction: Direction;
  /** Per-direction sequence number (independent spaces — see P2 note). */
  seq: number;
  /** Wall-clock creation time (unix ms) — the PRIMARY render-ordering key. */
  createdAt: number;
  text: string | null;
  status: Status;
  reactions?: string[];
  edited?: boolean;
  deleted?: boolean;
}

// Anchor "today" at a fixed wall-clock so the demo is deterministic.
const DAY = 24 * 60 * 60 * 1000;
const todayBase = new Date();
todayBase.setHours(9, 0, 0, 0);
const T = todayBase.getTime();
const Y = T - DAY; // yesterday

/**
 * P2 DEMONSTRATION DATA.
 *
 * Note how inbound and outbound `seq` both start at 1 and climb independently.
 * If we ordered by `seq` (with a direction tiebreak — the OLD behaviour), the
 * list would clump all `in:1,in:2,in:3` against `out:1,out:2,out:3` and the
 * conversation would read out of order ("jumbled"). Ordering by `createdAt`
 * (the FIX) interleaves them into the true back-and-forth below.
 */
const SAMPLE_MESSAGES: MockMessage[] = [
  // ----- Yesterday -----
  { id: 'm1', direction: 'out', seq: 1, createdAt: Y + 30 * 60000, text: 'Hey! Are we still on for lunch tomorrow?', status: 'sent' },
  { id: 'm2', direction: 'in', seq: 1, createdAt: Y + 32 * 60000, text: 'Yes — 12:30 at the usual place?', status: 'received' },
  { id: 'm3', direction: 'out', seq: 2, createdAt: Y + 33 * 60000, text: 'Perfect, see you then', status: 'sent', reactions: ['👍'] },
  // ----- Today -----
  { id: 'm4', direction: 'in', seq: 2, createdAt: T + 5 * 60000, text: 'Morning! Running 10 min late', status: 'received' },
  { id: 'm5', direction: 'in', seq: 3, createdAt: T + 5 * 60000 + 20_000, text: 'Grab us a table?', status: 'received' },
  { id: 'm6', direction: 'out', seq: 3, createdAt: T + 6 * 60000, text: 'No worries — got the corner booth', status: 'sent' },
  { id: 'm7', direction: 'out', seq: 4, createdAt: T + 6 * 60000 + 15_000, text: 'Ordered you a coffee', status: 'sent', edited: true },
  { id: 'm8', direction: 'in', seq: 4, createdAt: T + 8 * 60000, text: null, status: 'received', deleted: true },
  { id: 'm9', direction: 'in', seq: 5, createdAt: T + 9 * 60000, text: 'You are the best, thank you 🙏', status: 'received' },
  { id: 'm10', direction: 'out', seq: 5, createdAt: T + 10 * 60000, text: 'See you in a few!', status: 'sending' },
];

/** Two-digit HH:mm in local time. */
function hhmm(ms: number): string {
  const d = new Date(ms);
  const h = `${d.getHours()}`.padStart(2, '0');
  const m = `${d.getMinutes()}`.padStart(2, '0');
  return `${h}:${m}`;
}

/** Calendar-day key for day-separator grouping. */
function dayKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

/** "Today" / "Yesterday" / "12 Jun" pill label. */
function dayLabel(ms: number): string {
  const now = new Date();
  const today = dayKey(now.getTime());
  const yesterday = dayKey(now.getTime() - DAY);
  const key = dayKey(ms);
  if (key === today) return 'Today';
  if (key === yesterday) return 'Yesterday';
  const d = new Date(ms);
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

/** Status ticks for outbound bubbles. */
function statusTicks(status: Status): string {
  switch (status) {
    case 'sending':
      return '🕓';
    case 'sent':
      return '✓✓';
    case 'failed':
      return '!';
    default:
      return '';
  }
}

// Grouping window: consecutive same-direction messages closer than this share a run.
const GROUP_WINDOW_MS = 4 * 60 * 1000;

type Row =
  | { kind: 'day'; id: string; label: string }
  | { kind: 'message'; id: string; message: MockMessage; firstOfRun: boolean; lastOfRun: boolean };

/** Build the flat render list: chronological order + day separators + run flags. */
function buildRows(messages: MockMessage[]): Row[] {
  const sorted = [...messages].sort((a, b) => a.createdAt - b.createdAt);
  const rows: Row[] = [];
  for (let i = 0; i < sorted.length; i += 1) {
    const m = sorted[i];
    const prev = sorted[i - 1];
    const next = sorted[i + 1];

    if (prev === undefined || dayKey(prev.createdAt) !== dayKey(m.createdAt)) {
      rows.push({ kind: 'day', id: `day-${m.id}`, label: dayLabel(m.createdAt) });
    }

    const sameRunAsPrev =
      prev !== undefined &&
      prev.direction === m.direction &&
      dayKey(prev.createdAt) === dayKey(m.createdAt) &&
      m.createdAt - prev.createdAt <= GROUP_WINDOW_MS;
    const sameRunAsNext =
      next !== undefined &&
      next.direction === m.direction &&
      dayKey(next.createdAt) === dayKey(m.createdAt) &&
      next.createdAt - m.createdAt <= GROUP_WINDOW_MS;

    rows.push({
      kind: 'message',
      id: m.id,
      message: m,
      firstOfRun: !sameRunAsPrev,
      lastOfRun: !sameRunAsNext,
    });
  }
  return rows;
}

const OVERFLOW_ITEMS = [
  'Disappearing messages',
  'Verify identity',
  'Safety number',
  'Hide chat',
] as const;

export interface ConversationScreenMockupProps {
  peerName?: string;
  /** Open the contact/profile screen (tap name/avatar). Demo no-op by default. */
  onOpenProfile?: () => void;
  onBack?: () => void;
}

export function ConversationScreenMockup({
  peerName = 'Maya Patel',
  onOpenProfile,
  onBack,
}: ConversationScreenMockupProps): React.JSX.Element {
  const t = useTheme();
  const listRef = useRef<FlatList<Row>>(null);
  const [overflowOpen, setOverflowOpen] = useState(false);
  const [draft, setDraft] = useState('');

  const rows = useMemo(() => buildRows(SAMPLE_MESSAGES), []);

  return (
    <View style={[styles.screen, { backgroundColor: t.bg }]}>
      {/* ---------- P3: clean header ---------- */}
      <View style={[styles.header, { backgroundColor: t.surface, borderBottomColor: t.divider }]}>
        <Pressable hitSlop={12} onPress={onBack} accessibilityRole="button" accessibilityLabel="Back">
          <Icon name="back" size={24} color={t.brandSoft} />
        </Pressable>

        {/* Tappable avatar + name + ONE status line → opens the profile screen. */}
        <Pressable
          style={styles.headerIdentity}
          onPress={onOpenProfile}
          accessibilityRole="button"
          accessibilityLabel={`${peerName}, open profile`}
        >
          <View style={[styles.avatar, { backgroundColor: avatarColor(peerName) }]}>
            <Text style={styles.avatarText}>{initials(peerName)}</Text>
          </View>
          <View style={styles.headerBody}>
            <Text style={[styles.peerName, { color: t.text }]} numberOfLines={1}>
              {peerName}
            </Text>
            {/* Concise status line — "online" / "last seen …" / "🔒 encrypted". */}
            <Text style={[styles.headerStatus, { color: t.secure }]} numberOfLines={1}>
              online
            </Text>
          </View>
        </Pressable>

        {/* The ONLY header action: a single overflow button. */}
        <Pressable
          hitSlop={12}
          onPress={() => setOverflowOpen((v) => !v)}
          accessibilityRole="button"
          accessibilityLabel="More options"
          style={styles.overflowBtn}
        >
          <Icon name="more-vert" size={22} color={t.subtext} />
        </Pressable>

        {/* Overflow menu — the four actions that used to clutter the header. */}
        {overflowOpen && (
          <>
            <Pressable
              style={styles.overflowScrim}
              onPress={() => setOverflowOpen(false)}
              accessibilityLabel="Dismiss menu"
            />
            <View style={[styles.overflowMenu, { backgroundColor: t.surface, borderColor: t.divider }]}>
              {OVERFLOW_ITEMS.map((label, idx) => (
                <Pressable
                  key={label}
                  onPress={() => setOverflowOpen(false)}
                  style={[
                    styles.overflowItem,
                    idx > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: t.divider },
                  ]}
                  accessibilityRole="button"
                >
                  <Text style={[styles.overflowText, { color: t.text }]}>{label}</Text>
                </Pressable>
              ))}
            </View>
          </>
        )}
      </View>

      {/* ---------- P2 + P3: chronological, grouped, bottom-anchored list ---------- */}
      <FlatList
        ref={listRef}
        style={styles.list}
        contentContainerStyle={styles.listContent}
        data={rows}
        keyExtractor={(r) => r.id}
        // Bottom-anchor on first layout (newest message visible), per the design.
        onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: false })}
        renderItem={({ item }: ListRenderItemInfo<Row>) =>
          item.kind === 'day' ? (
            <DayPill label={item.label} theme={t} />
          ) : (
            <Bubble
              message={item.message}
              firstOfRun={item.firstOfRun}
              lastOfRun={item.lastOfRun}
              theme={t}
            />
          )
        }
      />

      {/* ---------- Clean composer ---------- */}
      <View style={[styles.composer, { backgroundColor: t.surface, borderTopColor: t.divider }]}>
        <TextInput
          style={[styles.input, { backgroundColor: t.field, color: t.text }]}
          value={draft}
          onChangeText={setDraft}
          placeholder="Message…"
          placeholderTextColor={t.faint}
          accessibilityLabel="Message"
        />
        <Pressable
          style={[styles.sendButton, { backgroundColor: t.brand }]}
          onPress={() => setDraft('')}
          accessibilityRole="button"
          accessibilityLabel="Send"
        >
          <Icon name="send" size={20} color={t.onBrand} />
        </Pressable>
      </View>
    </View>
  );
}

function DayPill({ label, theme: t }: { label: string; theme: Theme }): React.JSX.Element {
  return (
    <View style={styles.dayRow}>
      <View style={[styles.dayPill, { backgroundColor: t.field }]}>
        <Text style={[styles.dayPillText, { color: t.subtext }]}>{label}</Text>
      </View>
    </View>
  );
}

function Bubble({
  message,
  firstOfRun,
  lastOfRun,
  theme: t,
}: {
  message: MockMessage;
  firstOfRun: boolean;
  lastOfRun: boolean;
  theme: Theme;
}): React.JSX.Element {
  const outbound = message.direction === 'out';
  const deleted = message.deleted === true;
  const body = deleted ? 'message deleted' : (message.text ?? '');
  const ticks = outbound ? statusTicks(message.status) : '';

  // Sender grouping: tighter top margin within a run; only the last bubble of a
  // run gets the "tail" corner (a squared-off bottom corner on its own side).
  return (
    <View
      style={[
        styles.bubbleWrap,
        {
          alignSelf: outbound ? 'flex-end' : 'flex-start',
          marginTop: firstOfRun ? spacing.md : spacing.xs / 2,
        },
      ]}
    >
      <View
        style={[
          styles.bubble,
          outbound
            ? {
                backgroundColor: t.brand,
                opacity: message.status === 'sending' ? 0.6 : 1,
                borderBottomRightRadius: lastOfRun ? radius.sm / 2 : radius.lg,
              }
            : {
                backgroundColor: t.bubbleIn,
                borderWidth: 1,
                borderColor: t.divider,
                borderBottomLeftRadius: lastOfRun ? radius.sm / 2 : radius.lg,
              },
        ]}
      >
        <Text
          style={[
            styles.bubbleText,
            { color: outbound ? t.onBrand : t.text },
            deleted && styles.deletedText,
          ]}
        >
          {body}
        </Text>

        {/* Bubble footer: HH:mm time label + (outbound) status ticks. */}
        <View style={styles.bubbleFooter}>
          {message.edited === true && !deleted && (
            <Text style={[styles.edited, { color: outbound ? t.onBrand : t.faint }]}>edited</Text>
          )}
          <Text style={[styles.time, { color: outbound ? t.onBrand : t.faint }]}>
            {hhmm(message.createdAt)}
          </Text>
          {ticks.length > 0 && (
            <Text style={[styles.time, { color: t.onBrand }]}>{ticks}</Text>
          )}
        </View>
      </View>

      {/* A single reaction chip, anchored to the bubble's side. */}
      {message.reactions !== undefined && message.reactions.length > 0 && (
        <View
          style={[
            styles.reactionChip,
            { backgroundColor: t.field, borderColor: t.divider, alignSelf: outbound ? 'flex-end' : 'flex-start' },
          ]}
        >
          <Text style={styles.reactionChipText}>{message.reactions.join(' ')}</Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    gap: spacing.sm,
  },
  headerIdentity: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  avatar: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  avatarText: { color: '#fff', fontSize: 14, fontWeight: '700' },
  headerBody: { flex: 1 },
  peerName: { ...type.heading },
  headerStatus: { ...type.caption, marginTop: 2 },
  overflowBtn: { padding: spacing.xs },
  overflowScrim: { position: 'absolute', top: 0, left: 0, right: 0, bottom: -2000, zIndex: 5 },
  overflowMenu: {
    position: 'absolute',
    top: 54,
    right: spacing.md,
    minWidth: 200,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    paddingVertical: spacing.xs,
    zIndex: 10,
    // soft elevation for the floating card
    elevation: 6,
    shadowColor: '#000',
    shadowOpacity: 0.12,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
  },
  overflowItem: { paddingHorizontal: spacing.lg, paddingVertical: spacing.md },
  overflowText: { ...type.body },
  list: { flex: 1 },
  listContent: { paddingHorizontal: spacing.lg, paddingTop: spacing.sm, paddingBottom: spacing.md },
  dayRow: { alignItems: 'center', marginVertical: spacing.md },
  dayPill: { paddingHorizontal: spacing.md, paddingVertical: spacing.xs, borderRadius: radius.pill },
  dayPillText: { ...type.caption },
  bubbleWrap: { maxWidth: '78%' },
  bubble: { borderRadius: radius.lg, paddingHorizontal: spacing.md, paddingVertical: spacing.sm },
  bubbleText: { ...type.body },
  deletedText: { fontStyle: 'italic', opacity: 0.7 },
  bubbleFooter: { flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: spacing.xs, marginTop: 2 },
  edited: { ...type.caption, opacity: 0.8 },
  time: { ...type.caption, opacity: 0.85 },
  reactionChip: {
    marginTop: -spacing.xs,
    borderRadius: radius.pill,
    borderWidth: 1,
    paddingHorizontal: spacing.sm,
    paddingVertical: 1,
  },
  reactionChipText: { fontSize: 12 },
  composer: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: spacing.md,
    borderTopWidth: 1,
    gap: spacing.sm,
  },
  input: { flex: 1, borderRadius: radius.pill, paddingHorizontal: spacing.lg, paddingVertical: spacing.md, ...type.body },
  sendButton: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
});
