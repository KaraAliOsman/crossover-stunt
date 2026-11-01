import { SHOWCASE_SCENARIOS } from '../../sim/showcase.js';
import type { DemoChatRequest, ShowcaseRequest } from '../../shared/protocol.js';

export function parseDemoChat(value: unknown): DemoChatRequest | null {
  if (typeof value !== 'object' || value === null) return null;
  const candidate = value as Record<string, unknown>;
  // No usernames or message text accepted, even by the virtual injector.
  if (Object.keys(candidate).some((key) => !['side', 'count', 'seed'].includes(key))) return null;
  const { side, count, seed } = candidate;
  if (side !== 'A' && side !== 'B') return null;
  if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 1 || count > 3000)
    return null;
  if (typeof seed !== 'number' || !Number.isSafeInteger(seed) || seed < 0) return null;
  return { side, count, seed };
}

/** POST /dev/showcase body: `{ scenario: 'crossover' | 'so-close' | 'single' }` only. */
export function parseShowcaseRequest(value: unknown): ShowcaseRequest | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (Object.keys(candidate).some((key) => key !== 'scenario')) return null;
  const scenario = SHOWCASE_SCENARIOS.find((name) => name === candidate.scenario);
  return scenario === undefined ? null : { scenario };
}
