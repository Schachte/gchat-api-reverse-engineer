import { describe, expect, it, vi } from 'vitest';

import { parseTimeToUsec, throwIfAborted } from '../src/utils/time.ts';

describe('utils/time', () => {
  describe('parseTimeToUsec', () => {
    it('treats small numbers as seconds', () => {
      expect(parseTimeToUsec(1)).toBe(1_000_000);
      expect(parseTimeToUsec(123)).toBe(123_000_000);
    });

    it('treats mid-size numbers as milliseconds', () => {
      expect(parseTimeToUsec(1_000_000_000_000)).toBe(1_000_000_000_000_000);
    });

    it('treats large numbers as microseconds', () => {
      expect(parseTimeToUsec(1_700_000_000_000_000)).toBe(1_700_000_000_000_000);
    });

    it('parses numeric strings', () => {
      expect(parseTimeToUsec('123')).toBe(123_000_000);
      expect(parseTimeToUsec('  123  ')).toBe(123_000_000);
    });

    it('parses ISO-8601 strings', () => {
      expect(parseTimeToUsec('1970-01-01T00:00:01.000Z')).toBe(1_000_000);
    });

    it('parses relative time strings (ago)', () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date('2024-01-08T00:00:00.000Z'));
        expect(parseTimeToUsec('7d')).toBe(new Date('2024-01-01T00:00:00.000Z').getTime() * 1000);
        expect(parseTimeToUsec('24h')).toBe(new Date('2024-01-07T00:00:00.000Z').getTime() * 1000);
        expect(parseTimeToUsec('30m')).toBe(new Date('2024-01-07T23:30:00.000Z').getTime() * 1000);
        expect(parseTimeToUsec('1w')).toBe(new Date('2024-01-01T00:00:00.000Z').getTime() * 1000);
      } finally {
        vi.useRealTimers();
      }
    });

    it('returns undefined for invalid inputs', () => {
      expect(parseTimeToUsec('')).toBeUndefined();
      expect(parseTimeToUsec('   ')).toBeUndefined();
      expect(parseTimeToUsec('not-a-date')).toBeUndefined();
    });
  });

  describe('throwIfAborted', () => {
    it('throws when aborted', () => {
      const controller = new AbortController();
      throwIfAborted(controller.signal);
      controller.abort();
      expect(() => throwIfAborted(controller.signal)).toThrow('Aborted');
    });
  });
});

