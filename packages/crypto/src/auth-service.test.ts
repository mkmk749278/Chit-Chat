import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { AuthState } from '@chat-app/types';

import {
  AuthService,
  ExpiredOtpError,
  ReauthRequiredError,
} from './auth-service';
import type { AuthTokenProvider, OtpRequestResult, SignInResult, Unsubscribe } from './ports';

class FakeProvider implements AuthTokenProvider {
  token: string | null = 'tok';
  uid: string | null = 'alice';
  /** Queue of refresh outcomes: a string resolves, an Error rejects. */
  refreshOutcomes: Array<string | Error> = [];
  refreshCalls = 0;
  otpResult: OtpRequestResult = { ok: true };
  otpCalls = 0;
  confirmResult: SignInResult = { uid: 'alice', token: 'tok' };
  private stateListener: ((s: AuthState) => void) | null = null;

  getCurrentToken(): string | null {
    return this.token;
  }
  getCurrentUid(): string | null {
    return this.uid;
  }
  async requestPhoneOtp(): Promise<OtpRequestResult> {
    this.otpCalls += 1;
    return this.otpResult;
  }
  async confirmPhoneOtp(): Promise<SignInResult> {
    return this.confirmResult;
  }
  async refreshToken(): Promise<string> {
    const outcome = this.refreshOutcomes[this.refreshCalls] ?? new Error('no more outcomes');
    this.refreshCalls += 1;
    if (outcome instanceof Error) throw outcome;
    return outcome;
  }
  onAuthStateChanged(listener: (s: AuthState) => void): Unsubscribe {
    this.stateListener = listener;
    return () => {
      this.stateListener = null;
    };
  }
  async signOut(): Promise<void> {
    this.token = null;
    this.uid = null;
    this.stateListener?.({ status: 'signed-out' });
  }
}

// Feature: phase1-client-messaging, Property 12: Token-refresh retry is bounded.

test('refreshWithRetry returns the token on the first success and stops (Property 12)', async () => {
  const provider = new FakeProvider();
  provider.refreshOutcomes = ['fresh-token', 'should-not-be-used'];
  const auth = new AuthService(provider);

  const token = await auth.refreshWithRetry();

  assert.equal(token, 'fresh-token');
  assert.equal(provider.refreshCalls, 1, 'stops on first success');
});

test('refreshWithRetry succeeds on the third attempt after two failures', async () => {
  const provider = new FakeProvider();
  provider.refreshOutcomes = [new Error('f1'), new Error('f2'), 'fresh-token'];
  const auth = new AuthService(provider);

  assert.equal(await auth.refreshWithRetry(), 'fresh-token');
  assert.equal(provider.refreshCalls, 3);
});

test('refreshWithRetry throws ReauthRequiredError after 3 failures and emits reauth-required (Property 12, 1.9)', async () => {
  const provider = new FakeProvider();
  provider.refreshOutcomes = [new Error('f1'), new Error('f2'), new Error('f3'), 'unused'];
  const auth = new AuthService(provider);
  const states: AuthState[] = [];
  auth.onAuthStateChanged((s) => states.push(s));

  await assert.rejects(() => auth.refreshWithRetry(), ReauthRequiredError);
  assert.equal(provider.refreshCalls, 3, 'at most 3 attempts');
  assert.deepEqual(states.at(-1), { status: 'reauth-required' });
  assert.equal(auth.getAuthState().status, 'reauth-required');
});

// Requirement 1.10: OTP resend limit.

test('resendOtp permits 5 per window then refuses the 6th without calling the provider (1.10)', async () => {
  const provider = new FakeProvider();
  let clock = 0;
  const auth = new AuthService(provider, { now: () => clock });

  for (let i = 0; i < 5; i += 1) {
    const r = await auth.resendOtp('+15551230000');
    assert.equal(r.ok, true);
  }
  const sixth = await auth.resendOtp('+15551230000');
  assert.equal(sixth.ok, false);
  assert.equal(sixth.resendLimited, true);
  assert.equal(provider.otpCalls, 5, 'the refused resend never reaches the provider');
});

test('resend limit is a rolling window — resends are allowed again after it passes (1.10)', async () => {
  const provider = new FakeProvider();
  let clock = 0;
  const auth = new AuthService(provider, { now: () => clock, resendWindowMs: 1000 });

  for (let i = 0; i < 5; i += 1) await auth.resendOtp('+1');
  assert.equal((await auth.resendOtp('+1')).resendLimited, true);

  clock += 1001; // advance past the rolling window
  assert.equal((await auth.resendOtp('+1')).ok, true);
});

test('only successful resends count toward the limit (1.10)', async () => {
  const provider = new FakeProvider();
  provider.otpResult = { ok: false, error: 'sms failed' };
  const auth = new AuthService(provider, { now: () => 0 });

  for (let i = 0; i < 8; i += 1) {
    const r = await auth.resendOtp('+1');
    assert.equal(r.ok, false);
  }
  // None succeeded, so none counted; a later success is still permitted.
  provider.otpResult = { ok: true };
  assert.equal((await auth.resendOtp('+1')).ok, true);
});

// Requirement 1.11: code expiry.

test('confirmOtp rejects when no code was issued (1.11)', async () => {
  const auth = new AuthService(new FakeProvider(), { now: () => 0 });
  await assert.rejects(() => auth.confirmOtp('123456'), ExpiredOtpError);
});

test('confirmOtp rejects a code older than its TTL, before calling the provider (1.11)', async () => {
  const provider = new FakeProvider();
  let clock = 0;
  const auth = new AuthService(provider, { now: () => clock, codeTtlMs: 300_000 });

  await auth.requestOtp('+1'); // issues at clock=0
  clock = 300_001; // just past the 300s lifetime

  await assert.rejects(() => auth.confirmOtp('123456'), ExpiredOtpError);
});

test('confirmOtp accepts a code within its TTL and returns the sign-in result (1.11)', async () => {
  const provider = new FakeProvider();
  let clock = 0;
  const auth = new AuthService(provider, { now: () => clock });

  await auth.requestOtp('+1');
  clock = 100_000; // within 300s
  const result = await auth.confirmOtp('123456');
  assert.deepEqual(result, { uid: 'alice', token: 'tok' });
});

// Requirement 8.5: token never leaks via serialization.

test('the service redacts the token when serialized (8.5)', () => {
  const provider = new FakeProvider();
  provider.token = 'SUPERSECRETTOKENVALUE';
  const auth = new AuthService(provider);
  const json = JSON.stringify(auth);
  assert.ok(!json.includes('SUPERSECRETTOKENVALUE'), 'the token value must not be serialized');
  assert.ok(json.includes('[redacted]'));
});

test('getCurrentToken / getCurrentUid pass through to the provider (1.4)', () => {
  const provider = new FakeProvider();
  const auth = new AuthService(provider);
  assert.equal(auth.getCurrentToken(), 'tok');
  assert.equal(auth.getCurrentUid(), 'alice');
});
