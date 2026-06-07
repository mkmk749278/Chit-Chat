import assert from 'node:assert/strict';
import { test } from 'node:test';

import fc from 'fast-check';

import type { AuthState } from '@chat-app/types';

import { AuthService, ReauthRequiredError } from './auth-service';
import type { AuthTokenProvider, OtpRequestResult, SignInResult, Unsubscribe } from './ports';

/** Provider whose refreshToken plays out a scripted list of success/failure outcomes. */
class ScriptedProvider implements AuthTokenProvider {
  calls = 0;
  constructor(private readonly outcomes: boolean[]) {}
  getCurrentToken(): string | null {
    return 'tok';
  }
  getCurrentUid(): string | null {
    return 'uid';
  }
  async requestPhoneOtp(): Promise<OtpRequestResult> {
    return { ok: true };
  }
  async confirmPhoneOtp(): Promise<SignInResult> {
    return { uid: 'uid', token: 'tok' };
  }
  async refreshToken(): Promise<string> {
    const success = this.outcomes[this.calls] ?? false;
    this.calls += 1;
    if (!success) {
      throw new Error('refresh failed');
    }
    return `token-${this.calls}`;
  }
  onAuthStateChanged(_listener: (s: AuthState) => void): Unsubscribe {
    return () => undefined;
  }
  async signOut(): Promise<void> {}
}

test('Property 12: token-refresh retry is bounded', async () => {
  // Feature: phase1-client-messaging, Property 12: Token-refresh retry is bounded
  await fc.assert(
    fc.asyncProperty(fc.array(fc.boolean(), { maxLength: 10 }), async (outcomes) => {
      const provider = new ScriptedProvider(outcomes);
      const auth = new AuthService(provider);

      const firstSuccess = outcomes.slice(0, 3).indexOf(true);

      if (firstSuccess === -1) {
        // No success within the first 3 attempts → reauth-required after exactly 3 tries.
        await assert.rejects(() => auth.refreshWithRetry(), ReauthRequiredError);
        assert.equal(provider.calls, 3, 'exactly 3 attempts when all fail');
        assert.equal(auth.getAuthState().status, 'reauth-required');
      } else {
        // Succeeds and STOPS on the first success (no further attempts).
        const token = await auth.refreshWithRetry();
        assert.equal(token, `token-${firstSuccess + 1}`);
        assert.equal(provider.calls, firstSuccess + 1, 'stops on first success');
      }
      // In all cases: never more than 3 attempts (the bound).
      assert.ok(provider.calls <= 3);
    }),
    { numRuns: 200 },
  );
});
