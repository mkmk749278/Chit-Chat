import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { AuthState } from '@chat-app/types';

import { AuthService } from './auth-service';
import type { AuthTokenProvider, OtpRequestResult, SignInResult, Unsubscribe } from './ports';

/**
 * Example-based AuthService behaviours (task 2.20):
 *  - on sign-in the token + uid are exposed to consumers and a `signed-in` state is
 *    emitted (1.4);
 *  - a rejected credential surfaces the error and leaves the user signed-out, so the
 *    Sign_In_Screen can retain the entered phone number and show the failure (1.5).
 *
 * (1.7 — email/Google routing through the same token path — is an AuthTokenProvider
 * adapter concern: every method resolves a token via the same `getIdToken` path, so it
 * is exercised by the platform adapters, not the platform-agnostic core here.)
 */

class FakeProvider implements AuthTokenProvider {
  token: string | null = null;
  uid: string | null = null;
  confirmResult: SignInResult | Error = { uid: 'u1', token: 't1' };
  private listener: ((s: AuthState) => void) | null = null;

  getCurrentToken(): string | null {
    return this.token;
  }
  getCurrentUid(): string | null {
    return this.uid;
  }
  async requestPhoneOtp(): Promise<OtpRequestResult> {
    return { ok: true };
  }
  async confirmPhoneOtp(): Promise<SignInResult> {
    if (this.confirmResult instanceof Error) {
      throw this.confirmResult;
    }
    // Model a real provider: a successful confirm signs the user in.
    this.token = this.confirmResult.token;
    this.uid = this.confirmResult.uid;
    this.listener?.({ status: 'signed-in', uid: this.uid, token: this.token });
    return this.confirmResult;
  }
  async refreshToken(): Promise<string> {
    return this.token ?? 't1';
  }
  onAuthStateChanged(listener: (s: AuthState) => void): Unsubscribe {
    this.listener = listener;
    return () => {
      this.listener = null;
    };
  }
  async signOut(): Promise<void> {
    this.token = null;
    this.uid = null;
  }
}

test('1.4: on sign-in the token + uid are exposed and a signed-in state is emitted', async () => {
  const provider = new FakeProvider();
  const auth = new AuthService(provider, { now: () => 0 });
  const states: AuthState[] = [];
  auth.onAuthStateChanged((s) => states.push(s));

  await auth.requestOtp('+15551230000');
  const result = await auth.confirmOtp('123456');

  assert.deepEqual(result, { uid: 'u1', token: 't1' });
  assert.equal(auth.getCurrentToken(), 't1');
  assert.equal(auth.getCurrentUid(), 'u1');
  assert.deepEqual(states.at(-1), { status: 'signed-in', uid: 'u1', token: 't1' });
});

test('1.5: a rejected credential surfaces the error and leaves the user signed-out', async () => {
  const provider = new FakeProvider();
  provider.confirmResult = new Error('auth/invalid-verification-code');
  const auth = new AuthService(provider, { now: () => 0 });

  await auth.requestOtp('+15551230000');
  await assert.rejects(() => auth.confirmOtp('000000'), /invalid-verification-code/);

  // Not signed in → the Sign_In_Screen stays up (and retains the phone number).
  assert.equal(auth.getCurrentToken(), null);
  assert.equal(auth.getCurrentUid(), null);
});
