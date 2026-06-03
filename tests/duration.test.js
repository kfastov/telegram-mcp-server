import { describe, expect, it } from 'vitest';

import { parseDuration } from '../core/duration.js';

describe('parseDuration', () => {
  it('returns null for empty or non-string input', () => {
    expect(parseDuration('')).toBeNull();
    expect(parseDuration('   ')).toBeNull();
    expect(parseDuration(undefined)).toBeNull();
    expect(parseDuration(null)).toBeNull();
    expect(parseDuration(30)).toBeNull();
  });

  it('treats a bare number as seconds', () => {
    expect(parseDuration('30')).toBe(30_000);
    expect(parseDuration('0')).toBe(0);
  });

  it('honors unit suffixes', () => {
    expect(parseDuration('500ms')).toBe(500);
    expect(parseDuration('5s')).toBe(5_000);
    expect(parseDuration('2m')).toBe(120_000);
    expect(parseDuration('1h')).toBe(3_600_000);
  });

  it('is case-insensitive and trims whitespace', () => {
    expect(parseDuration('  10S ')).toBe(10_000);
    expect(parseDuration('250MS')).toBe(250);
  });

  it('throws on an unparseable value', () => {
    expect(() => parseDuration('bogus')).toThrow(/Invalid duration/);
    expect(() => parseDuration('10x')).toThrow(/Invalid duration/);
  });
});
