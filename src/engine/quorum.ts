/** Round up so a positive fractional target never undershoots the chosen ratio. */
export function computeQuorum(recentDistinct: number, minimum: number, ratio: number): number {
  if (!Number.isSafeInteger(recentDistinct) || recentDistinct < 0) {
    throw new RangeError('recentDistinct must be a non-negative safe integer');
  }
  if (!Number.isSafeInteger(minimum) || minimum < 1) {
    throw new RangeError('minimum must be a positive safe integer');
  }
  if (!Number.isFinite(ratio) || ratio <= 0 || ratio > 1) {
    throw new RangeError('ratio must be in (0, 1]');
  }
  return Math.max(minimum, Math.ceil(recentDistinct * ratio));
}

/** True when a chatter last seen at `lastSeenMs` is outside the recent window ending at `now`. */
function isExpired(lastSeenMs: number, now: number, windowMs: number): boolean {
  return lastSeenMs < now - windowMs;
}

/**
 * Exact prune used when CALL freezes the quorum: keeps chatters seen at or after
 * `now - windowMs`. Returns the same Map when nothing expires (cheap equality for callers).
 */
export function pruneRecentChatters(
  recent: ReadonlyMap<string, number>,
  now: number,
  windowMs: number,
): ReadonlyMap<string, number> {
  let expired = false;
  for (const lastSeenMs of recent.values()) {
    if (isExpired(lastSeenMs, now, windowMs)) {
      expired = true;
      break;
    }
  }
  if (!expired) return recent;
  const kept = new Map<string, number>();
  for (const [chatterId, lastSeenMs] of recent) {
    if (!isExpired(lastSeenMs, now, windowMs)) kept.set(chatterId, lastSeenMs);
  }
  return kept;
}

/**
 * Records that `chatterId` spoke at `now` without mutating `recent`.
 *
 * The returned Map is ordered by recency (a refreshed chatter moves to the end), so expired
 * entries accumulate at the front and are evicted here in amortized O(1). This bounds memory
 * by the window during long idle stretches between rounds. With out-of-order clocks the front
 * eviction is only approximate; `pruneRecentChatters` at CALL is the exact baseline.
 * Returns the same Map when the chatter is already recorded at `now` or later.
 */
export function observeChatter(
  recent: ReadonlyMap<string, number>,
  chatterId: string,
  now: number,
  windowMs: number,
): ReadonlyMap<string, number> {
  const previous = recent.get(chatterId);
  if (previous !== undefined && previous >= now) return recent;
  const next = new Map(recent);
  next.delete(chatterId);
  next.set(chatterId, now);
  for (const [oldestId, lastSeenMs] of next) {
    if (!isExpired(lastSeenMs, now, windowMs)) break;
    next.delete(oldestId);
  }
  return next;
}
