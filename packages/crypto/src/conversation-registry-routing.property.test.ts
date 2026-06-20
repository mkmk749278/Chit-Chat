import assert from 'node:assert/strict';
import { test } from 'node:test';

import fc from 'fast-check';

import {
  initialConversationState,
  reduce,
  type ConversationEvent,
  type ConversationState,
} from './conversation-reducer';
import { DefaultConversationRegistry, type ConversationKey } from './conversation-registry';
import { SHADOW_SEQ_OFFSET } from './shadow-sequence-allocator';

/**
 * Property tests for the {@link DefaultConversationRegistry} recipient-routing override + clear/close
 * (Shadow Chat Invites, design Component D). These cover the additive Task-4 surface (`markSurfaceVisible`
 * / `clearThread` / `closeThread`) and carry forward the shipped per-thread isolation guarantee under
 * the new `merge into main` view choice.
 *
 * Validates:
 *   - design Correctness Property 5  — per-thread isolation (carried forward, incl. under `merge`):
 *                                       a `threadId`-tagged event mutates ONLY `shadow:${threadId}`.
 *   - design Correctness Property 7  — recipient-routing-choice correctness: `hidden` ⇒ absent from
 *                                       the surface list + non-notifiable; `merge` ⇒ present under
 *                                       `peerUid` + notifiable; in BOTH the thread's own state/seqs
 *                                       are unchanged.
 *   - design Correctness Property 18 — clear keeps the chat working: after `clearThread` the state is
 *                                       empty yet a later event on the same `threadId` routes back to
 *                                       `shadow:${threadId}`; no other conversation is touched.
 *
 * Runs >=100 randomised iterations per property and reports fast-check's counterexample on failure.
 */

const SHADOW_THREADS = ['thread-1', 'thread-2', 'thread-3'] as const;
type Lane = 'surface' | (typeof SHADOW_THREADS)[number];
const PEER = 'peer-uid';
const ALL_LANES: Lane[] = ['surface', ...SHADOW_THREADS];

const laneArb: fc.Arbitrary<Lane> = fc.constantFrom('surface', ...SHADOW_THREADS);

/** Base seq for a lane: surface < 1e9 <= shadow (faithful to the real allocator spaces). */
function seqBase(lane: Lane): number {
  return lane === 'surface' ? 0 : SHADOW_SEQ_OFFSET;
}

/** A raw, lane-agnostic event shape; tagging with remoteUid/threadId happens in {@link tag}. */
type RawEvent =
  | { kind: 'append'; direction: 'in' | 'out'; n: number; text: string }
  | { kind: 'reaction'; targetDirection: 'in' | 'out'; n: number; emoji: string }
  | { kind: 'edit'; targetDirection: 'in' | 'out'; n: number; body: string }
  | { kind: 'delete'; targetDirection: 'in' | 'out'; n: number }
  | { kind: 'timer'; ttlMs: number };

const nArb = fc.integer({ min: 1, max: 12 });
const dirArb = fc.constantFrom<'in' | 'out'>('in', 'out');

const rawEventArb: fc.Arbitrary<RawEvent> = fc.oneof(
  fc.record({
    kind: fc.constant<'append'>('append'),
    direction: dirArb,
    n: nArb,
    text: fc.string({ maxLength: 8 }),
  }),
  fc.record({
    kind: fc.constant<'reaction'>('reaction'),
    targetDirection: dirArb,
    n: nArb,
    emoji: fc.constantFrom('👍', '🔥', '😀', '❤️'),
  }),
  fc.record({
    kind: fc.constant<'edit'>('edit'),
    targetDirection: dirArb,
    n: nArb,
    body: fc.string({ maxLength: 8 }),
  }),
  fc.record({ kind: fc.constant<'delete'>('delete'), targetDirection: dirArb, n: nArb }),
  fc.record({ kind: fc.constant<'timer'>('timer'), ttlMs: fc.integer({ min: 0, max: 1_000_000 }) }),
);

/** Materialise a raw event into a real {@link ConversationEvent} tagged for `lane`. */
function tag(lane: Lane, raw: RawEvent): ConversationEvent {
  const threadTag = lane === 'surface' ? {} : { threadId: lane };
  const base = seqBase(lane);
  switch (raw.kind) {
    case 'append':
      return {
        type: 'message-appended',
        message: {
          id: `${lane}-${raw.direction}-${raw.n}`,
          seq: base + raw.n,
          direction: raw.direction,
          text: raw.text,
          status: raw.direction === 'out' ? 'sending' : 'received',
        },
        remoteUid: PEER,
        ...threadTag,
      };
    case 'reaction':
      return {
        type: 'reaction-applied',
        targetDirection: raw.targetDirection,
        targetSeq: base + raw.n,
        emoji: raw.emoji,
        remoteUid: PEER,
        ...threadTag,
      };
    case 'edit':
      return {
        type: 'message-edited',
        targetDirection: raw.targetDirection,
        targetSeq: base + raw.n,
        body: raw.body,
        remoteUid: PEER,
        ...threadTag,
      };
    case 'delete':
      return {
        type: 'message-deleted',
        targetDirection: raw.targetDirection,
        targetSeq: base + raw.n,
        remoteUid: PEER,
        ...threadTag,
      };
    case 'timer':
      return { type: 'timer-changed', ttlMs: raw.ttlMs, remoteUid: PEER, ...threadTag };
  }
}

const keyForLane = (lane: Lane): ConversationKey =>
  lane === 'surface'
    ? { kind: 'surface', remoteUid: PEER }
    : { kind: 'shadow', threadId: lane, peerUid: PEER };

/** A registry with the surface peer and every shadow thread pre-opened. */
function freshRegistry(): DefaultConversationRegistry {
  const registry = new DefaultConversationRegistry();
  for (const t of SHADOW_THREADS) {
    registry.openShadowThread(t, PEER);
  }
  return registry;
}

test('Property 5: a threadId-tagged event mutates ONLY shadow:${threadId}, even when markSurfaceVisible was called', () => {
  // design Correctness Property 5 (per-thread isolation, carried forward incl. under `merge`).
  fc.assert(
    fc.property(
      fc.array(fc.record({ lane: laneArb, event: rawEventArb }), { minLength: 1, maxLength: 60 }),
      // Independently choose, per shadow thread, whether to mark it surface-visible (merge).
      fc.record({
        'thread-1': fc.boolean(),
        'thread-2': fc.boolean(),
        'thread-3': fc.boolean(),
      }),
      (steps, merged) => {
        const registry = freshRegistry();
        // markSurfaceVisible is a pure VIEW override: it must not perturb routing/isolation.
        for (const t of SHADOW_THREADS) {
          if (merged[t]) {
            registry.markSurfaceVisible(t);
          }
        }
        // Oracle: each lane reduced in complete isolation through the same pure reducer.
        const oracle = new Map<Lane, ConversationState>(
          ALL_LANES.map((lane) => [lane, initialConversationState('mobile')]),
        );

        for (const { lane, event } of steps) {
          const tagged = tag(lane, event);
          registry.apply(tagged);
          oracle.set(lane, reduce(oracle.get(lane)!, tagged));
        }

        // Every lane's registry state equals its isolated oracle state — nothing bled across lanes,
        // and the merge view-override changed nothing about per-thread reduction.
        for (const lane of ALL_LANES) {
          assert.deepEqual(
            registry.getState(keyForLane(lane)),
            oracle.get(lane),
            `lane "${lane}" diverged from its isolated reduction (merged=${JSON.stringify(merged)})`,
          );
        }

        // Cross-thread disjointness: each lane only ever holds its own id-prefixed messages.
        for (const lane of ALL_LANES) {
          for (const message of registry.getState(keyForLane(lane)).messages) {
            assert.ok(
              message.id.startsWith(`${lane}-`),
              `lane "${lane}" contains a message "${message.id}" from another thread`,
            );
          }
        }
      },
    ),
    { numRuns: 200 },
  );
});

test('Property 7: hidden ⇒ absent + non-notifiable; merge ⇒ present-under-peerUid + notifiable; the threads own state/seqs unchanged in BOTH', () => {
  // design Correctness Property 7 (recipient-routing-choice correctness).
  fc.assert(
    fc.property(
      fc.record({
        'thread-1': fc.boolean(),
        'thread-2': fc.boolean(),
        'thread-3': fc.boolean(),
      }),
      fc.array(rawEventArb, { minLength: 1, maxLength: 20 }),
      (merged, perThreadEvents) => {
        const registry = freshRegistry();

        // Seed each shadow thread with the same set of events (so all have non-trivial state/seqs).
        for (const t of SHADOW_THREADS) {
          for (const raw of perThreadEvents) {
            registry.apply(tag(t, raw));
          }
        }
        // Snapshot each thread's own isolated state BEFORE any view override.
        const stateBefore = new Map<Lane, ConversationState>(
          SHADOW_THREADS.map((t) => [t, registry.getState(keyForLane(t))]),
        );

        // Apply the routing choice per thread.
        for (const t of SHADOW_THREADS) {
          if (merged[t]) {
            registry.markSurfaceVisible(t);
          }
        }

        const list = registry.listSurfaceConversations();

        for (const t of SHADOW_THREADS) {
          const surfacedEntries = list.filter((e) => e.state === stateBefore.get(t));
          const notifiable = registry.isNotifiable(
            tag(t, { kind: 'append', direction: 'in', n: 1, text: 'x' }),
          );
          if (merged[t]) {
            // merge ⇒ present in the surface list under peerUid, and notifiable.
            assert.equal(surfacedEntries.length, 1, `merged thread "${t}" must appear once`);
            assert.equal(surfacedEntries[0]?.remoteUid, PEER, `merged "${t}" under peerUid`);
            assert.equal(notifiable, true, `merged thread "${t}" must be notifiable`);
          } else {
            // hidden ⇒ absent from the surface list, and non-notifiable.
            assert.equal(surfacedEntries.length, 0, `hidden thread "${t}" must be absent`);
            assert.equal(notifiable, false, `hidden thread "${t}" must be non-notifiable`);
          }
          // In BOTH cases the thread's own ConversationState instance is byte-for-byte unchanged
          // (the override is purely a view concern — the +1e9 seqs and gap detection are untouched).
          assert.strictEqual(
            registry.getState(keyForLane(t)),
            stateBefore.get(t),
            `routing choice mutated thread "${t}"'s own state`,
          );
        }

        // The genuine surface conversation (never created here) contributes nothing.
        assert.ok(
          list.every((e) => SHADOW_THREADS.some((t) => stateBefore.get(t) === e.state)),
          'only merged shadow threads appear in the surface list',
        );
      },
    ),
    { numRuns: 200 },
  );
});

test('Property 18: after clearThread the state is empty yet a new event routes back to shadow:${threadId}; no other conversation touched', () => {
  // design Correctness Property 18 (clear keeps the chat working).
  fc.assert(
    fc.property(
      laneArb.filter((l): l is (typeof SHADOW_THREADS)[number] => l !== 'surface'),
      fc.array(rawEventArb, { minLength: 0, maxLength: 20 }),
      rawEventArb,
      (target, seed, afterClear) => {
        const registry = freshRegistry();
        // Give the surface conversation and every shadow thread some history.
        registry.apply(tag('surface', { kind: 'append', direction: 'out', n: 7, text: 's' }));
        for (const t of SHADOW_THREADS) {
          for (const raw of seed) {
            registry.apply(tag(t, raw));
          }
        }
        // Snapshot every conversation EXCEPT the clear target.
        const others = ALL_LANES.filter((l) => l !== target);
        const before = new Map(others.map((l) => [l, registry.getState(keyForLane(l))]));

        registry.clearThread(target);

        // The cleared thread is empty: no messages, no gap markers, timer reset.
        const cleared = registry.getState(keyForLane(target));
        assert.deepEqual(cleared.messages, [], `clearThread left messages on "${target}"`);
        assert.deepEqual(cleared.missingBefore, [], `clearThread left gap markers on "${target}"`);
        assert.equal(cleared.disappearingTtlMs, 0, `clearThread left a timer on "${target}"`);

        // No other conversation touched — each other state object is the identical instance.
        for (const l of others) {
          assert.strictEqual(
            registry.getState(keyForLane(l)),
            before.get(l),
            `clearThread("${target}") mutated "${l}"`,
          );
        }

        // Still routable: a new (locally-initiated outbound or any) event routes back to the thread.
        const followUp = tag(target, afterClear);
        assert.doesNotThrow(() => registry.apply(followUp));
        // The follow-up landed in THIS thread and nowhere else.
        const after = registry.getState(keyForLane(target));
        const oracle = reduce(initialConversationState('mobile'), followUp);
        assert.deepEqual(
          after,
          oracle,
          `a post-clear event on "${target}" did not route back to its empty thread`,
        );
      },
    ),
    { numRuns: 200 },
  );
});
