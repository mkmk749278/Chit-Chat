/**
 * `apps/mobile` — durable, on-device storage for the user's display name.
 *
 * The display name is what onboarding collects ("What's your name?") and is gated on in the
 * app shell: a returning user must skip onboarding. Previously the name lived ONLY on the
 * backend (`POST /api/directory/profile`) and was read back via `whoAmI()` on launch — so any
 * time that round-trip failed (backend unreachable, the same condition that fails encryption
 * setup), the name was forgotten and the user was re-prompted on EVERY launch.
 *
 * This store persists the name locally so onboarding happens once per account on a device,
 * independent of the backend and of the (separately failing) encrypted crypto vault. The name
 * is not secret — peers see it by design — so it lives in plain {@link AsyncStorage}; it is
 * namespaced by uid so distinct accounts on one device never inherit each other's name, and is
 * cleared on explicit sign-out.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

/** Storage key for a uid's display name (namespaced so accounts never collide). */
const displayNameKey = (uid: string): string => `chat.profile.displayName.v1.${uid}`;

/** Read the locally-saved display name for `uid`, or `null` if none is stored. */
export async function loadDisplayName(uid: string): Promise<string | null> {
  try {
    const stored = await AsyncStorage.getItem(displayNameKey(uid));
    return stored !== null && stored.length > 0 ? stored : null;
  } catch {
    // A read failure is non-fatal: the caller falls back to (re-)prompting for the name.
    return null;
  }
}

/** Durably save `displayName` for `uid` so onboarding is skipped on the next launch. */
export async function saveDisplayName(uid: string, displayName: string): Promise<void> {
  try {
    await AsyncStorage.setItem(displayNameKey(uid), displayName);
  } catch {
    // Best-effort: a write failure only means the name may be re-prompted later.
  }
}

/** Erase the locally-saved display name for `uid` (explicit sign-out hygiene). */
export async function clearDisplayName(uid: string): Promise<void> {
  try {
    await AsyncStorage.removeItem(displayNameKey(uid));
  } catch {
    // A clear failure must not block sign-out.
  }
}
