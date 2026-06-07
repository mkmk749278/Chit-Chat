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
      // Distinctive, non-trivial token values (avoid empty / coincidental substrings).
      fc.string({ minLength: 8, maxLength: 64 }).filter((t) => t.trim().length >= 8),
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
