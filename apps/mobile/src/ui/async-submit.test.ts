/**
 * Tests for the shared busy-UI gating helpers used by the async setup/unlock screens
 * (P1 freeze fix — `ui-modernization-and-setup-fix`, Requirement 1.3).
 *
 * These exercise the exact decision every screen (AppLock / Onboarding / Settings / hide-sheet /
 * reveal) relies on: WHILE a setup or unlock hash is in flight, the submit control is disabled and a
 * progress indicator is shown, and a control cannot launch two concurrent hashes.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { runBusy, submitGate } from './async-submit';

test('submitGate disables and shows progress while a hash is in flight', () => {
  // Valid input, not busy: actionable, no spinner.
  assert.deepEqual(submitGate({ valid: true, busy: false }), { disabled: false, showProgress: false });
  // Valid input, busy: disabled AND spinner shown (Requirement 1.3).
  assert.deepEqual(submitGate({ valid: true, busy: true }), { disabled: true, showProgress: true });
});

test('submitGate disables on invalid input or an active lockout', () => {
  assert.equal(submitGate({ valid: false, busy: false }).disabled, true);
  assert.equal(submitGate({ valid: true, locked: true, busy: false }).disabled, true);
  // A lockout never spuriously shows the in-progress spinner.
  assert.equal(submitGate({ valid: true, locked: true, busy: false }).showProgress, false);
});

test('runBusy toggles busy around the action and reports completion', async () => {
  const transitions: boolean[] = [];
  let busyDuringAction: boolean | null = null;
  const ran = await runBusy({
    enabled: true,
    busy: false,
    setBusy: (next) => transitions.push(next),
    action: () => {
      // The flag must be set true while the action runs.
      busyDuringAction = transitions[transitions.length - 1] ?? null;
    },
  });
  assert.equal(ran, true);
  assert.equal(busyDuringAction, true);
  // Busy set true at start, cleared false at finish.
  assert.deepEqual(transitions, [true, false]);
});

test('runBusy clears the busy flag even when the action rejects', async () => {
  const transitions: boolean[] = [];
  await assert.rejects(() =>
    runBusy({
      enabled: true,
      busy: false,
      setBusy: (next) => transitions.push(next),
      action: () => Promise.reject(new Error('hash failed')),
    }),
  );
  // Still cleared to false in the finally block, so the control re-enables.
  assert.deepEqual(transitions, [true, false]);
});

test('runBusy refuses to launch a second concurrent hash (re-entrancy guard)', async () => {
  let calls = 0;
  const ran = await runBusy({
    enabled: true,
    busy: true, // a run is already in flight
    setBusy: () => undefined,
    action: () => {
      calls += 1;
    },
  });
  assert.equal(ran, false);
  assert.equal(calls, 0);
});

test('runBusy does nothing when the control is not enabled', async () => {
  let calls = 0;
  const transitions: boolean[] = [];
  const ran = await runBusy({
    enabled: false,
    busy: false,
    setBusy: (next) => transitions.push(next),
    action: () => {
      calls += 1;
    },
  });
  assert.equal(ran, false);
  assert.equal(calls, 0);
  assert.deepEqual(transitions, []); // never toggled busy
});
