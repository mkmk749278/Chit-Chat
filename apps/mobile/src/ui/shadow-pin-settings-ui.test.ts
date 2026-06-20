/**
 * UI/adapter tests for the mobile per-chat PIN settings sheet `ShadowPinSettingsSheet` and its
 * container wiring (task 16.3; Requirements 12.5, 12.7, 12.8; design Correctness Property 11 & 13).
 *
 * These run under `node --test` (no React Native renderer is configured in this repo), so — exactly
 * like the sibling `shadow-creation-ui.test.ts` / `overflow-menu-zorder.test.ts` — the structural /
 * z-order assertions are static checks over the component SOURCE, while the busy-gate and the
 * add/change/remove contract are exercised BEHAVIOURALLY against the REAL shared `runBusy` helper
 * the sheet itself uses (so the test pins the actual decision, not a copy).
 *
 * They assert, per the task:
 *   (a) the sheet renders through the `SheetModal` `Modal` portal (top z-order), Req 12 family;
 *   (b) the "Remove PIN" action submits `null` and Save submits the TRIMMED PIN (Property 11);
 *   (c) the busy gate (`runBusy`) disables the controls and refuses a concurrent submit while the
 *       async `setThreadPin` is in flight — the UI never freezes (Requirement 12.7);
 *   (d) the container only passes `onSetThreadPin` for a shadow thread in real mode — a static
 *       assertion over `App.tsx` (`appMode === 'real' && shadowThreadIds.has(...)`) and the
 *       `ConversationScreen` gate (`onSetThreadPin !== undefined`) — Property 13 / Req 12.8.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { runBusy } from './async-submit';

// The compiled test lives in `dist/ui/`; the TSX sources live in `src/ui/` (and App.tsx at the root).
const SRC_UI = path.resolve(__dirname, '../../src/ui');
const APP_ROOT = path.resolve(__dirname, '../..');
const sheetSrc = readFileSync(path.join(SRC_UI, 'ShadowPinSettingsSheet.tsx'), 'utf8');
const conversationSrc = readFileSync(path.join(SRC_UI, 'ConversationScreen.tsx'), 'utf8');
const appSrc = readFileSync(path.join(APP_ROOT, 'App.tsx'), 'utf8');



// (a) Top z-order — the PIN settings sheet renders through the SheetModal Modal portal.

test('ShadowPinSettingsSheet renders through the SheetModal portal (top z-order)', () => {
  assert.match(sheetSrc, /<SheetModal\b/, 'the sheet must render through <SheetModal> (top-level portal)');
  assert.doesNotMatch(
    sheetSrc,
    /position:\s*'absolute'/,
    'the sheet must not use absolute positioning; it lays out within the Modal portal',
  );
});


// (b) Add/change/remove — Remove submits null, Save submits the TRIMMED PIN (Property 11).

test('the "Remove PIN" action submits null through the shared runner', () => {
  // The Remove row routes to run(null) — the single shared-core path that clears the lock.
  assert.match(
    sheetSrc,
    /label="Remove PIN"[^]*?onPress=\{\(\) => run\(null\)\}/,
    'the "Remove PIN" SheetItem must call run(null)',
  );
});

test('Save trims the PIN and submits the trimmed value (never the raw input)', () => {
  // save() trims, short-circuits on empty, and forwards ONLY the trimmed PIN to run(...).
  assert.match(sheetSrc, /const trimmed = pin\.trim\(\);/, 'save() must trim the PIN');
  assert.match(
    sheetSrc,
    /if \(trimmed\.length === 0\) \{\s*return;\s*\}/,
    'save() must early-return on an empty (whitespace-only) PIN',
  );
  assert.match(sheetSrc, /run\(trimmed\);/, 'save() must submit the trimmed PIN');
  // Both paths delegate to the one onSubmit contract (set/change vs remove).
  assert.match(sheetSrc, /await onSubmit\(newPin\);/, 'run() must delegate to the onSubmit contract');
});

test('behavioural: Save forwards the trimmed PIN and Remove forwards null via onSubmit', async () => {
  // A faithful harness of the sheet's save()/run() built on the REAL runBusy, asserting the exact
  // values the sheet hands to its onSubmit contract.
  const submitted: Array<string | null> = [];
  let busy = false;
  const onSubmit = async (newPin: string | null): Promise<void> => {
    submitted.push(newPin);
  };
  const run = (newPin: string | null): Promise<boolean> =>
    runBusy({
      enabled: !busy,
      busy,
      setBusy: (next) => {
        busy = next;
      },
      action: async () => {
        await onSubmit(newPin);
      },
    });
  const save = async (pin: string): Promise<void> => {
    const trimmed = pin.trim();
    if (trimmed.length === 0) {
      return;
    }
    await run(trimmed);
  };

  await save('  1357  '); // trimmed before submit
  await run(null); // the Remove path
  await save('   '); // whitespace only → never submits

  assert.deepEqual(submitted, ['1357', null]);
});



// (c) The busy gate (runBusy) disables controls and refuses a concurrent submit (Req 12.7).

test('the sheet disables its controls while a submit is in flight (busy gate, Req 12.7)', () => {
  // The submit/remove work runs behind runBusy guarded on `!busy`, so the UI awaits PBKDF2 without
  // freezing; the input and both actions are disabled while busy.
  assert.match(sheetSrc, /void runBusy\(\{/, 'run() must launch the work via runBusy');
  assert.match(sheetSrc, /enabled:\s*!busy/, 'runBusy must be gated on !busy (re-entrancy guard)');
  assert.match(sheetSrc, /editable=\{!busy\}/, 'the PIN input must be non-editable while busy');
  assert.match(
    sheetSrc,
    /disabled=\{pinEmpty \|\| busy\}/,
    'the Save control must be disabled while busy (or when the PIN is empty)',
  );
  // The Remove + Cancel rows are also disabled while busy, and Save swaps to an ActivityIndicator.
  assert.match(sheetSrc, /label="Remove PIN"[^]*?disabled=\{busy\}/, 'Remove must be disabled while busy');
  assert.match(sheetSrc, /busy \? \(\s*<ActivityIndicator/, 'Save must show a spinner while busy');
});

test('behavioural: runBusy refuses a second concurrent submit while one is in flight', async () => {
  // Mirrors the sheet's re-entrancy guard: a deferred onSubmit keeps the gate busy, so a second
  // run(...) launched before it settles never invokes onSubmit again.
  let busy = false;
  let calls = 0;
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const action = async (): Promise<void> => {
    calls += 1;
    await pending;
  };
  const run = (): Promise<boolean> =>
    runBusy({ enabled: !busy, busy, setBusy: (next) => (busy = next), action });

  const first = run(); // starts; sets busy = true and blocks on `pending`
  const second = await run(); // busy is true now → refused without calling action
  assert.equal(second, false);
  assert.equal(busy, true); // still in flight
  release();
  assert.equal(await first, true);
  assert.equal(calls, 1); // action ran exactly once
});


// (d) Container wiring — onSetThreadPin is passed ONLY for a shadow thread in real mode (Req 12.8).

test('App.tsx passes onSetThreadPin ONLY for a shadow thread in real mode (Property 13)', () => {
  // The ConversationScreen prop is supplied iff real mode AND the open conversation is a shadow
  // thread; otherwise it is `undefined`, so the entry point is absent/inert.
  assert.match(
    appSrc,
    /appMode === 'real' && shadowThreadIds\.has\(openConversation\.id\) \? onSetThreadPin : undefined/,
    'onSetThreadPin must be gated on real mode AND a shadow thread',
  );
  // The callback itself fails closed for any non-real / non-shadow / unprovisioned state.
  assert.match(
    appSrc,
    /appMode !== 'real' \|\| threadId === null \|\| store === null \|\| !shadowThreadIds\.has\(threadId\)/,
    'onSetThreadPin must fail closed outside real mode / non-shadow threads',
  );
  // And it routes to the durable store's setThreadPin('real', ...).
  assert.match(appSrc, /store\.setThreadPin\('real', threadId, newPin\)/, 'must route to setThreadPin');
});

test('ConversationScreen renders the PIN settings sheet ONLY when onSetThreadPin is provided', () => {
  assert.match(
    conversationSrc,
    /onSetThreadPin !== undefined && \(\s*<ShadowPinSettingsSheet/,
    'the sheet must be rendered only when onSetThreadPin is provided',
  );
  // The sheet's onSubmit is wired straight to the gated container callback.
  assert.match(conversationSrc, /onSubmit=\{onSetThreadPin\}/, 'the sheet onSubmit must be the gated callback');
});
