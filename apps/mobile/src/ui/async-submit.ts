/**
 * Shared busy-UI helpers for the async setup/unlock screens (P1 freeze fix —
 * `ui-modernization-and-setup-fix`, Requirement 1.3).
 *
 * The PIN / decoy / hide-chat / unlock / reveal flows call into `secret-hash`, whose PBKDF2
 * derivation now runs off-thread but still takes real time. Requirement 1.3 says: WHILE a setup or
 * unlock hash is in flight, the screen SHALL show an in-progress indicator and disable the submit
 * control until the operation resolves. These tiny, pure helpers encapsulate that decision so every
 * screen (AppLock / Onboarding / Settings / hide-sheet / reveal) shares one tested code path.
 *
 * No React, no I/O — fully unit-testable under `node --test`.
 */

/** Inputs that decide whether a submit control is actionable. */
export interface SubmitGateInput {
  /** Whether the current input passes validation (e.g. a 4–6 digit PIN). */
  valid: boolean;
  /** Whether the control is disabled by an external lockout. Optional; defaults to not-locked. */
  locked?: boolean;
  /** Whether an async submit (hash) is currently in flight. */
  busy: boolean;
}

/** The derived UI state for a submit control. */
export interface SubmitGate {
  /** True when the submit control must be disabled (invalid input, locked out, or hashing). */
  disabled: boolean;
  /** True when the in-progress indicator (spinner) must be shown. */
  showProgress: boolean;
}

/**
 * Decide whether the submit control is disabled and whether to show progress. A control is disabled
 * when the input is invalid, a lockout is active, OR a hash is in flight; the spinner shows exactly
 * while busy.
 */
export function submitGate(input: SubmitGateInput): SubmitGate {
  const disabled = !input.valid || input.locked === true || input.busy;
  return { disabled, showProgress: input.busy };
}

/**
 * Run an async submit `action` exactly once at a time behind a busy flag. Returns `false` without
 * invoking `action` when the control is not `enabled` or a run is already in flight (re-entrancy
 * guard — a double-tap can't launch two concurrent hashes). Otherwise sets busy `true` for the
 * duration of `action` and clears it afterwards (even if `action` throws), then returns `true`.
 *
 * `action` may be synchronous (`void`) or asynchronous (`Promise<void>`); either way `busy` stays
 * set until it settles, so the in-progress indicator reflects the real in-flight window.
 */
export async function runBusy(opts: {
  enabled: boolean;
  busy: boolean;
  setBusy: (next: boolean) => void;
  action: () => void | Promise<void>;
}): Promise<boolean> {
  if (!opts.enabled || opts.busy) {
    return false;
  }
  opts.setBusy(true);
  try {
    await opts.action();
  } finally {
    opts.setBusy(false);
  }
  return true;
}
