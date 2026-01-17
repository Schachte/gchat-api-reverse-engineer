/**
 * Time helpers shared across higher-level utilities.
 */

/**
 * Parse a time value to microseconds.
 *
 * Supports:
 * - microseconds (number/string)
 * - milliseconds, seconds
 * - ISO 8601 strings
 * - Relative time strings: "24h", "7d", "1w", "30m" (ago)
 */
export function parseTimeToUsec(value: number | string): number | undefined {
  if (typeof value === 'number') {
    // If < 10^10, assume seconds; if < 10^13, assume milliseconds; else microseconds
    if (value < 1e10) return value * 1_000_000;
    if (value < 1e13) return value * 1_000;
    return value;
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return undefined;

    // Try parsing as number first
    if (/^\d+$/.test(trimmed)) {
      return parseTimeToUsec(parseInt(trimmed, 10));
    }

    // Relative time (e.g., "24h", "7d", "1w", "30m")
    const relativeMatch = trimmed.match(/^(\d+)(m|h|d|w)$/i);
    if (relativeMatch) {
      const amount = parseInt(relativeMatch[1], 10);
      const unit = relativeMatch[2].toLowerCase();
      const now = Date.now();
      let msAgo = 0;
      switch (unit) {
        case 'm': msAgo = amount * 60 * 1000; break;
        case 'h': msAgo = amount * 60 * 60 * 1000; break;
        case 'd': msAgo = amount * 24 * 60 * 60 * 1000; break;
        case 'w': msAgo = amount * 7 * 24 * 60 * 60 * 1000; break;
      }
      return (now - msAgo) * 1000;
    }

    // ISO 8601 date
    const date = new Date(trimmed);
    if (!Number.isNaN(date.getTime())) {
      return date.getTime() * 1000;
    }
  }

  return undefined;
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new Error('Aborted');
  }
}

