import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  computeExpiresAt,
  msUntilNextExpiry,
  NO_EXPIRY,
  selectExpired,
  type ExpiringEntry,
} from './disappearing-timer';

/**
 * Tests for disappearing-message expiry math (Phase 2, Requirement 4). Pure, clock-injected.
 */

test('computeExpiresAt adds ttl to the start instant', () => {
  assert.equal(computeExpiresAt(1_000, 5_000), 6_000);
});

test('computeExpiresAt returns NO_EXPIRY for a disabled timer (ttl <= 0)', () => {
  assert.equal(computeExpiresAt(1_000, 0), NO_EXPIRY);
  assert.equal(computeExpiresAt(1_000, -10), NO_EXPIRY);
});

test('selectExpired returns only entries at or past their expiry', () => {
  const entries: ExpiringEntry[] = [
    { id: 'a', expiresAt: 100 },
    { id: 'b', expiresAt: 200 },
    { id: 'c', expiresAt: NO_EXPIRY },
  ];
  assert.deepEqual(selectExpired(entries, 150), ['a']);
  assert.deepEqual(selectExpired(entries, 200), ['a', 'b']); // boundary is inclusive
  assert.deepEqual(selectExpired(entries, 50), []);
});

test('selectExpired never selects no-timer (non-finite) entries', () => {
  const entries: ExpiringEntry[] = [{ id: 'x', expiresAt: NO_EXPIRY }];
  assert.deepEqual(selectExpired(entries, Number.MAX_SAFE_INTEGER), []);
});

test('view-once (expiresAt = display time) expires immediately on display', () => {
  const displayedAt = 5_000;
  const entry: ExpiringEntry = { id: 'vo', expiresAt: displayedAt };
  assert.deepEqual(selectExpired([entry], displayedAt), ['vo']);
});

test('msUntilNextExpiry returns time to the soonest pending expiry', () => {
  const entries: ExpiringEntry[] = [
    { id: 'a', expiresAt: 1_000 },
    { id: 'b', expiresAt: 400 },
    { id: 'c', expiresAt: NO_EXPIRY },
  ];
  assert.equal(msUntilNextExpiry(entries, 100), 300); // 400 - 100
});

test('msUntilNextExpiry clamps already-expired to 0 (purge now)', () => {
  assert.equal(msUntilNextExpiry([{ id: 'a', expiresAt: 100 }], 500), 0);
});

test('msUntilNextExpiry is null when nothing has a timer', () => {
  assert.equal(msUntilNextExpiry([{ id: 'a', expiresAt: NO_EXPIRY }], 0), null);
  assert.equal(msUntilNextExpiry([], 0), null);
});
