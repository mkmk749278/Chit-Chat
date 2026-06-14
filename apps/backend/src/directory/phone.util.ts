/**
 * Canonical E.164 normalization for phone-based discovery.
 *
 * Discovery only works if the number stored at registration and the number looked up are
 * byte-identical. To guarantee that regardless of how either side formats the input (spaces,
 * hidden characters, a leading `00`, etc.), we reduce every number to a single canonical
 * form — `+` followed by its digits — and store/look up THAT form on both sides.
 */

/**
 * Reduce a phone number to canonical E.164: strip everything except digits and return them
 * prefixed with `+`. Idempotent for already-clean E.164 input (`+919618579123` →
 * `+919618579123`). A leading `00` international prefix is treated as the `+`.
 */
export function normalizeE164(raw: string): string {
  let digits = raw.replace(/[^\d]/g, '');
  // Some inputs use the `00` international call prefix instead of `+`.
  if (digits.startsWith('00')) {
    digits = digits.slice(2);
  }
  return `+${digits}`;
}
