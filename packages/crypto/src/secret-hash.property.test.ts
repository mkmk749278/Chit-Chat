import assert from 'node:assert/strict';
import { pbkdf2 } from 'node:crypto';
import { test } from 'node:test';

import fc from 'fast-check';

import {
  DEFAULT_SECRET_ITERATIONS,
  getPbkdf2Provider,
  hashSecret,
  setPbkdf2Provider,
  verifySecret,
  type Pbkdf2Provider,
} from './secret-hash';

/**
 * Property tests for the injected `Pbkdf2Provider` seam (Feature: ui-modernization-and-setup-fix,
 * Properties 5–8). Run under `node --test` + `fast-check`. The provider only changes *where* the
 * PBKDF2 bits are derived; the verifier format, fresh salting, and constant-time compare are
 * unchanged. A low iteration count keeps the real-KDF properties fast, exactly as the existing
 * `secret-hash` suite does.
 */

const ITER = 1000;

/** Capture the default provider once so every test can restore it and stay isolated. */
const DEFAULT_PROVIDER = getPbkdf2Provider();

/**
 * A second, fully independent PBKDF2-HMAC-SHA256 implementation (Node's native `crypto.pbkdf2`).
 * Because it computes the same RFC 8018 function as the WebCrypto default, verifiers must be
 * interchangeable between the two.
 */
const nodePbkdf2Provider: Pbkdf2Provider = {
  deriveBits(password, salt, iterations, keyLenBytes) {
    return new Promise((resolve, reject) => {
      pbkdf2(Buffer.from(password), Buffer.from(salt), iterations, keyLenBytes, 'sha256', (err, derived) =>
        err || derived == null ? reject(err ?? new Error('pbkdf2 failed')) : resolve(new Uint8Array(derived)),
      );
    });
  },
};

/** Run `fn` with `provider` installed, always restoring the default afterwards. */
async function withProvider<T>(provider: Pbkdf2Provider, fn: () => Promise<T>): Promise<T> {
  setPbkdf2Provider(provider);
  try {
    return await fn();
  } finally {
    setPbkdf2Provider(DEFAULT_PROVIDER);
  }
}

test('Property 5: KDF provider interchangeability (migration safety)', async () => {
  // Feature: ui-modernization-and-setup-fix, Property 5: KDF provider interchangeability
  await fc.assert(
    fc.asyncProperty(fc.string({ minLength: 1, maxLength: 40 }), async (secret) => {
      // A verifier produced under the WebCrypto default verifies true under the Node provider...
      const storedUnderDefault = await withProvider(DEFAULT_PROVIDER, () => hashSecret(secret, ITER));
      assert.equal(await withProvider(nodePbkdf2Provider, () => verifySecret(secret, storedUnderDefault)), true);

      // ...and a verifier produced under the Node provider verifies true under the WebCrypto default.
      const storedUnderNode = await withProvider(nodePbkdf2Provider, () => hashSecret(secret, ITER));
      assert.equal(await withProvider(DEFAULT_PROVIDER, () => verifySecret(secret, storedUnderNode)), true);

      // And the self-consistency `verifySecret(s, hashSecret(s))` holds under either single provider.
      for (const provider of [DEFAULT_PROVIDER, nodePbkdf2Provider]) {
        const verified = await withProvider(provider, async () =>
          verifySecret(secret, await hashSecret(secret, ITER)),
        );
        assert.equal(verified, true);
      }
    }),
    { numRuns: 100 },
  );
});

test('Property 6: verifier format + fresh salting unchanged', async () => {
  // Feature: ui-modernization-and-setup-fix, Property 6: Verifier format + salting unchanged.
  // A fast deterministic provider lets us exercise the REAL DEFAULT_SECRET_ITERATIONS (>= 210000)
  // cheaply across many runs — the format string, salt, and iteration value never depend on the
  // derived bytes, so this faithfully checks the emitted verifier shape and fresh salting.
  const fastProvider: Pbkdf2Provider = {
    async deriveBits(_password, _salt, _iterations, keyLenBytes) {
      return new Uint8Array(keyLenBytes).fill(7);
    },
  };

  await withProvider(fastProvider, async () => {
    await fc.assert(
      fc.asyncProperty(fc.string({ minLength: 1, maxLength: 40 }), async (secret) => {
        const a = await hashSecret(secret);
        const b = await hashSecret(secret);

        // Format: pbkdf2$sha256$<iters>$<saltB64>$<hashB64>.
        for (const stored of [a, b]) {
          const parts = stored.split('$');
          assert.equal(parts.length, 5);
          assert.equal(parts[0], 'pbkdf2');
          assert.equal(parts[1], 'sha256');
          const iters = Number.parseInt(parts[2], 10);
          assert.ok(Number.isInteger(iters) && iters >= 210_000, 'iterations >= 210000');
          assert.equal(iters, DEFAULT_SECRET_ITERATIONS);
        }

        // Fresh salt per call: the same secret yields different verifiers (different salt segment).
        assert.notEqual(a, b);
        assert.notEqual(a.split('$')[3], b.split('$')[3]);
      }),
      { numRuns: 100 },
    );
  });

  // The plaintext secret is absent from the emitted verifier. Uses the REAL (one-way) KDF so the
  // hash segment genuinely cannot encode the secret; secrets are long enough not to collide with the
  // fixed structural tokens (`pbkdf2`, `sha256`, the iteration literal).
  await withProvider(nodePbkdf2Provider, async () => {
    await fc.assert(
      fc.asyncProperty(fc.string({ minLength: 8, maxLength: 40 }), async (secret) => {
        const stored = await hashSecret(secret, ITER);
        assert.ok(!stored.includes(secret), 'plaintext secret must not appear in the verifier');
      }),
      { numRuns: 100 },
    );
  });
});

test('Property 7: constant-time, total verification', async () => {
  // Feature: ui-modernization-and-setup-fix, Property 7: Constant-time, total verification.
  // For arbitrary secrets and random / foreign / malformed `stored` strings, verifySecret resolves
  // to a boolean and never throws. A fast provider keeps the many-input sweep cheap.
  const fastProvider: Pbkdf2Provider = {
    async deriveBits(_password, _salt, _iterations, keyLenBytes) {
      return new Uint8Array(keyLenBytes).fill(3);
    },
  };

  const storedArb = fc.oneof(
    fc.string(), // arbitrary junk
    fc.constantFrom(
      '',
      'not-a-verifier',
      'pbkdf2$sha256$abc$salt$hash',
      'bcrypt$sha256$1000$c2FsdA==$aGFzaA==',
      'pbkdf2$sha256$1000$$',
      'pbkdf2$sha256$-1$c2FsdA==$aGFzaA==',
    ),
    // A real-shaped foreign verifier (valid base64 salt/hash, fields well-formed).
    fc
      .tuple(
        fc.nat({ max: 500_000 }),
        fc.uint8Array({ minLength: 1, maxLength: 16 }),
        fc.uint8Array({ minLength: 1, maxLength: 32 }),
      )
      .map(
        ([iters, salt, hash]) =>
          `pbkdf2$sha256$${iters + 1}$${Buffer.from(salt).toString('base64')}$${Buffer.from(hash).toString('base64')}`,
      ),
  );

  await withProvider(fastProvider, async () => {
    await fc.assert(
      fc.asyncProperty(fc.string(), storedArb, async (secret, stored) => {
        const result = await verifySecret(secret, stored);
        assert.equal(typeof result, 'boolean');
      }),
      { numRuns: 300 },
    );
  });
});

test('Property 8: no synchronous KDF on the JS thread (provider seam)', async () => {
  // Feature: ui-modernization-and-setup-fix, Property 8: derivation flows ONLY through the provider.
  await fc.assert(
    fc.asyncProperty(
      fc.string({ minLength: 1, maxLength: 40 }),
      fc.integer({ min: 1, max: 5000 }),
      async (secret, iterations) => {
        const calls: Array<{ iterations: number; keyLenBytes: number; saltLen: number; passwordLen: number }> = [];
        const recordingProvider: Pbkdf2Provider = {
          async deriveBits(password, salt, iters, keyLenBytes) {
            calls.push({ iterations: iters, keyLenBytes, saltLen: salt.length, passwordLen: password.length });
            // Deterministic bytes; no per-iteration loop inside the module under test.
            return new Uint8Array(keyLenBytes).fill(1);
          },
        };

        await withProvider(recordingProvider, async () => {
          calls.length = 0;
          const stored = await hashSecret(secret, iterations);
          // hashSecret derives exactly once, through the provider, with the requested iteration count.
          assert.equal(calls.length, 1);
          assert.equal(calls[0]!.iterations, iterations);
          assert.equal(calls[0]!.keyLenBytes, 32);
          assert.equal(calls[0]!.saltLen, 16);

          calls.length = 0;
          await verifySecret(secret, stored);
          // verifySecret also derives exactly once, through the provider — never an inline loop.
          assert.equal(calls.length, 1);
          assert.equal(calls[0]!.iterations, iterations);
          assert.equal(calls[0]!.keyLenBytes, 32);
        });
      },
    ),
    { numRuns: 100 },
  );
});
