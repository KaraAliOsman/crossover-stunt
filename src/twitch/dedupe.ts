/** Bounded "seen" set with least-recently-seen eviction, for delivery deduplication. */

/** Envelope IDs (and chat message keys) remembered across subscriptions and reconnect overlap. */
export const DEDUPE_CAPACITY = 2_000;

export interface LruSet {
  /** Records `key`; returns true when it was new, false for a duplicate (which is refreshed). */
  add(key: string): boolean;
  has(key: string): boolean;
  readonly size: number;
  clear(): void;
}

export function createLruSet(capacity: number = DEDUPE_CAPACITY): LruSet {
  if (!Number.isInteger(capacity) || capacity < 1) {
    throw new RangeError('LRU capacity must be a positive integer');
  }
  // Map preserves insertion order: the first key is always the least recently seen.
  const keys = new Map<string, true>();
  return {
    add(key) {
      if (keys.has(key)) {
        keys.delete(key);
        keys.set(key, true);
        return false;
      }
      keys.set(key, true);
      if (keys.size > capacity) {
        const oldest = keys.keys().next().value;
        if (oldest !== undefined) keys.delete(oldest);
      }
      return true;
    },
    has: (key) => keys.has(key),
    get size() {
      return keys.size;
    },
    clear: () => keys.clear(),
  };
}
