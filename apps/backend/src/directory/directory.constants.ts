/**
 * DirectoryModule constants — the `POST /api/directory/resolve` rate-limit configuration.
 *
 * Phone→UID resolution is the contact-discovery surface, so it is rate-limited per
 * authenticated uid to blunt phone-number enumeration (a signed-in caller cannot probe an
 * unbounded number of phone numbers). Mirrors the device-registration limiter style and
 * stays within the limiter's permitted ranges (`1..1000000` / `1..86400`).
 */

/** Max phone-resolution lookups allowed per window for a single authenticated uid. */
export const DIRECTORY_RATE_LIMIT = 60;

/** Length of the directory rate-limit window, in seconds. */
export const DIRECTORY_RATE_WINDOW_SECONDS = 60;

/** The `{scope}` portion of the directory rate-limit key (`directory:{uid}`). */
export const DIRECTORY_RATE_LIMIT_SCOPE = 'directory';
