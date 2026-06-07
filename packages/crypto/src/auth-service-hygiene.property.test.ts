import assert from 'node:assert/strict';
import { inspect } from 'node:util';
import { test } from 'node:test';

import fc from 'fast-check';

import type { AuthState } from '@chat-app/types';

import { AuthService, ReauthRequiredError } from './auth-service';
import type { AuthTokenProvider, OtpRequestResult, SignInResult, Unsubscribe } from './ports';

/** Provider whose refresh fails with an error that (maliciously) embeds the token. */
class TokenLeakingProvider implements AuthTokenProvider {
  constructor(private readonly token: string) {}
  getCurrentToken(): string | null {
    return this.token;
  }
  getCurrentUid(): string | null {
    return 'uid';
  }
  async requestPhoneOtp(): Promise<OtpRequestResult> {
    return { ok: true };
  }
  async confirmPhoneOtp(): Promise<SignInResult> {
    return { uid: 'uid', token: this.token };
  }
  async refreshToken(): Promise<string> {
    // Simulate an SDK error that carries the token value — the AuthService must NOT
    // surface it (it swallows the underlying error and throws a clean reauth error).
    throw new Error(`refresh failed for token=${this.token}`);
  }
  onAuthStateChanged(_l: (s: AuthState) => void): Unsubscribe {
    return () => undefined;
  }
  async signOut(): Promise<void> {}
}

test('Property 20: the token never appears in serialization, inspection, or surfaced errors', async () => {
  // Feature: phase1-client-messaging, Property 20: No secrets in logs or error reports
  await fc.assert(
    fc.asyncProperty(
      // Distinctive token values: a fixed `tkn-` prefix + a long hex body. This models a
      // real secret while guaranteeing the value can never be a coincidental substring of
      // the fixed redaction/error text (e.g. "[redacted]", "reauth-required",
      // "Re-authentication is required") — whose longest hex run is only a few chars — so
      // the test fails ONLY on a genuine leak, never on a string collision.
      fc.hexaString({ minLength: 16, maxLength: 56 }).map((hex) => `tkn-${hex}`),
      async (token) => {
        const auth = new AuthService(new TokenLeakingProvider(token));

        // 1. The service redacts on JSON serialization and util.inspect.
        assert.ok(!JSON.stringify(auth).includes(token));
        assert.ok(!inspect(auth).includes(token));

        // 2. A surfaced reauth error (after refresh exhaustion) carries no token.
        try {
          await auth.refreshWithRetry();
          assert.fail('expected reauth-required');
        } catch (err) {
          assert.ok(err instanceof ReauthRequiredError);
          assert.ok(!String((err as Error).message).includes(token));
          assert.ok(!inspect(err).includes(token));
        }
      },
    ),
    { numRuns: 150 },
  );
});
