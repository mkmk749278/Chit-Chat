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
 * Property test for the {@link DefaultConversationRegistry} (Shadow Chat, design Component 5).
 *
 * Feature: shadow-chat. Validates design **Correctness Property 8 (thread isolation / no
 * cross-thread bleed)**: for any interleaving of surface and shadow message/reaction/edit/delete/
 * timer events routed through the registry, the surface {@link ConversationState} and each shadow
 * {@link ConversationState} share no message, reaction, edit, delete, or timer, and an event tagged
 * with a `threadId` affects ONLY that thread's state (Requirements 7.2, 7.3, 7.4). Runs >=100
 * randomised iterations and reports fast-check's counterexample on failure.
 *
 * Method: drive the registry with a random interleaving across a small pool of lanes (one surface +
 * a few pre-opened shadow threads), and in parallel maintain an ORACLE that reduces each lane's
 * events in complete isolation through the same pure {@link reduce}. The registry's per-lane state
 * must equal the isolated oracle state for every lane — i.e. routing through the registry is
 * observationally identical to never letting the lanes touch, which is exactly "no cross-thread
 * bleed".
 */

/** A lane is either the surface conversation or one of a small pool of shadow threads. */
const SHADOW_THREADS = ['thread-1', 'thread-2', 'thread-3'] as const;
type Lane = 'surface' | (typeof SHADOW_THREADS)[number];
const PEER = 'peer-uid';

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

const ALL_LANES: Lane[] = ['surface', ...SHADOW_THREADS];

test('Property 8: registry routing is observationally identical to isolated per-thread reduction (no cross-thread bleed)', () => {
  // Feature: shadow-chat, Correctness Property 8 (thread isolation / no cross-thread bleed).
  fc.assert(
    fc.property(
      fc.array(fc.record({ lane: laneArb, event: rawEventArb }), { minLength: 1, maxLength: 60 }),
      (steps) => {
        const registry = new DefaultConversationRegistry();
        // Pre-open every shadow thread so its events are accepted (the e2e/UI opens threads first).
        for (const t of SHADOW_THREADS) {
          registry.openShadowThread(t, PEER);
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

        // Every lane's registry state equals its isolated oracle state — nothing bled across lanes.
        for (const lane of ALL_LANES) {
          assert.deepEqual(
            registry.getState(keyForLane(lane)),
            oracle.get(lane),
            `lane "${lane}" diverged from its isolated reduction`,
          );
        }

        // Explicit cross-thread disjointness: a message/reaction/edit/delete/timer from one lane
        // never appears in another lane's state (each lane uses a disjoint seq space + id prefix).
        for (const lane of ALL_LANES) {
          const state = registry.getState(keyForLane(lane));
          for (const message of state.messages) {
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

test('Property 8: a threadId-tagged event leaves every OTHER thread byte-for-byte unchanged', () => {
  // Feature: shadow-chat, Correctness Property 8 (an event affects only its own thread).
  fc.assert(
    fc.property(laneArb, rawEventArb, (lane, raw) => {
      const registry = new DefaultConversationRegistry();
      for (const t of SHADOW_THREADS) {
        registry.openShadowThread(t, PEER);
      }
      // Snapshot every OTHER lane before applying the single event.
      const others = ALL_LANES.filter((l) => l !== lane);
      const before = new Map(others.map((l) => [l, registry.getState(keyForLane(l))]));

      registry.apply(tag(lane, raw));

      // Each other lane's state object is the identical, unmodified instance.
      for (const l of others) {
        assert.strictEqual(
          registry.getState(keyForLane(l)),
          before.get(l),
          `applying to "${lane}" mutated "${l}"`,
        );
      }
    }),
    { numRuns: 200 },
  );
});
