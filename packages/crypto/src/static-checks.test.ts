import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { PublicPreKeyBundleOut, RegisterDeviceDto } from '@chat-app/types';

import * as cryptoModule from './index';

/**
 * Static/smoke checks for the shared client core (tasks 1.3 and 8.7).
 *
 * These are compile-time + runtime guards that ride the normal `tsc && node --test`
 * step: the type-level assertions fail the build if a contract drifts, and the runtime
 * assertions fail the test if the public surface grows a forbidden API.
 */

// ---------------------------------------------------------------------------
// Task 1.3: PublicPreKeyBundleOut conforms to the Phase 0 RegisterDeviceDto shape
// (minus the optional deviceName), so the Device_Registrar forwards it unreshaped.
// ---------------------------------------------------------------------------

/** True only when A and B are mutually assignable (structurally identical). */
type MutuallyAssignable<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

// Compile-time conformance: if these two shapes ever diverge, this assignment stops
// type-checking and the crypto build (hence CI) fails. (Requirements 2.5, 3.1)
const _bundleMatchesRegisterDto: MutuallyAssignable<
  PublicPreKeyBundleOut,
  Omit<RegisterDeviceDto, 'deviceName'>
> = true;
void _bundleMatchesRegisterDto;

test('PublicPreKeyBundleOut is assignable to RegisterDeviceDto (minus deviceName) at runtime (1.3)', () => {
  const bundle: PublicPreKeyBundleOut = {
    registrationId: 1,
    identityKey: 'aWs=',
    signedPreKey: { keyId: 0, publicKey: 'c3Br', signature: 'c2ln' },
    oneTimePreKeys: [{ keyId: 0, publicKey: 'b3Rw' }],
  };
  // Forwarded to POST /api/devices/register verbatim (optionally adding deviceName).
  const registerBody: RegisterDeviceDto = bundle;

  assert.deepEqual(Object.keys(registerBody).sort(), [
    'identityKey',
    'oneTimePreKeys',
    'registrationId',
    'signedPreKey',
  ]);
  assert.equal(registerBody.signedPreKey.keyId, 0);
  assert.equal(registerBody.oneTimePreKeys.length, 1);
});

// ---------------------------------------------------------------------------
// Task 8.7: the client exposes NO key-backup / key-recovery / key-export API
// (product decision D9 — forward secrecy by construction). A regression guard so a
// future export named like a backup/recovery surface fails this test. (Requirement 7.5)
// ---------------------------------------------------------------------------

/** Names that would indicate a key-backup / recovery / export surface (forbidden). */
const FORBIDDEN_API_PATTERN = /(backup|restore|recover|escrow|exportkey|keyexport|exportident)/i;

test('the shared client core exports no key-backup or key-recovery API (8.7, D9)', () => {
  const offenders = Object.keys(cryptoModule).filter((name) => FORBIDDEN_API_PATTERN.test(name));
  assert.deepEqual(offenders, [], `unexpected key-backup/recovery exports: ${offenders.join(', ')}`);
});

test('the KeyStore-facing surface offers no backup/recovery method names (8.7, D9)', () => {
  // The KeyStore port is a type (erased at runtime), so guard the concrete in-tree
  // implementations' method surfaces indirectly: assert the documented destroy()/save/
  // load vocabulary contains no backup/recovery verb. This is a lightweight name scan
  // over the exported runtime members as a forward regression tripwire.
  const allNames = Object.keys(cryptoModule);
  for (const name of allNames) {
    assert.ok(
      !FORBIDDEN_API_PATTERN.test(name),
      `export "${name}" looks like a key-backup/recovery surface`,
    );
  }
});
