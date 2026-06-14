import { normalizeE164 } from './phone.util';

/**
 * normalizeE164 must collapse every formatting variant of the SAME number to one canonical
 * string, so a number stored at registration and a number looked up always compare equal.
 */
describe('normalizeE164', () => {
  it('is idempotent for already-clean E.164', () => {
    expect(normalizeE164('+919618579123')).toBe('+919618579123');
  });

  it('strips spaces, dashes, parentheses, and other formatting', () => {
    expect(normalizeE164('+91 96185 79123')).toBe('+919618579123');
    expect(normalizeE164('+91-9618-579123')).toBe('+919618579123');
    expect(normalizeE164(' +91 (961) 857-9123 ')).toBe('+919618579123');
  });

  it('strips trailing/hidden whitespace that would break an exact match', () => {
    expect(normalizeE164('+919618579123\n')).toBe('+919618579123');
    expect(normalizeE164('+919618579123​')).toBe('+919618579123');
  });

  it('treats a leading 00 international prefix as +', () => {
    expect(normalizeE164('00919618579123')).toBe('+919618579123');
  });

  it('adds the leading + when missing', () => {
    expect(normalizeE164('919618579123')).toBe('+919618579123');
  });
});
