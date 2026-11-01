/**
 * Runtime validation helpers for untrusted Twitch JSON. Every network payload is `unknown` until it
 * passes through one of these checks; a TypeScript cast is never treated as validation.
 */

export type JsonRecord = Readonly<Record<string, unknown>>;

/** Marker returned by the tri-state readers when a present value has the wrong type. */
export const INVALID: unique symbol = Symbol('invalid');
export type Invalid = typeof INVALID;

export function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Non-empty string or null. */
export function readString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** Absent, null or empty → null; non-empty string → string; anything else → INVALID. */
export function readNullableString(value: unknown): string | null | Invalid {
  if (value === undefined || value === null || value === '') return null;
  return typeof value === 'string' ? value : INVALID;
}

/** Finite number or null. */
export function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Array whose items are all strings, or null. */
export function readStringArray(value: unknown): readonly string[] | null {
  if (!Array.isArray(value)) return null;
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') return null;
    out.push(item);
  }
  return out;
}

/** The `data` array of a Helix response envelope, or null when the body does not have that shape. */
export function readDataArray(body: unknown): readonly unknown[] | null {
  if (!isRecord(body)) return null;
  const data: unknown = body.data;
  return Array.isArray(data) ? (data as readonly unknown[]) : null;
}

/** Twitch error bodies look like `{ status, error?, message }`; returns the `message` if any. */
export function readErrorMessage(body: unknown): string | null {
  return isRecord(body) ? readString(body.message) : null;
}
