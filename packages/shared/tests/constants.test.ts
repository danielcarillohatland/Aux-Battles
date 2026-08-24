import { describe, expect, it } from 'vitest';
import { ROOM_ALPHABET, ROOM_CODE_KEYSPACE, ROOM_CODE_LENGTH } from '../src/constants.js';

describe('ROOM_ALPHABET', () => {
  it('has exactly 31 symbols', () => {
    expect(ROOM_ALPHABET.length).toBe(31);
  });

  it('excludes ambiguous glyphs (0/O/1/I/L)', () => {
    for (const bad of ['0', 'O', '1', 'I', 'L']) {
      expect(ROOM_ALPHABET.includes(bad)).toBe(false);
    }
  });

  it('contains only uppercase letters and digits, all unique', () => {
    expect(ROOM_ALPHABET).toMatch(/^[A-Z2-9]+$/);
    expect(new Set(ROOM_ALPHABET).size).toBe(31);
    // 23 letters (A–Z minus I, L, O) + 8 digits (2–9) = 31.
  });

  it('keyspace matches length^count', () => {
    expect(ROOM_CODE_KEYSPACE).toBe(31 ** ROOM_CODE_LENGTH);
  });
});
