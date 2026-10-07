import { createHash } from 'node:crypto';

/** Minimal JSON value model used for all serializable payloads. */
export type JsonValue = string | number | boolean | null | JsonObject | JsonArray;
export interface JsonObject {
  [key: string]: JsonValue;
}
export interface JsonArray extends Array<JsonValue> {}

export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Canonical JSON: recursively sorted object keys, no insignificant
 * whitespace. Two logically equal values always produce identical strings,
 * which makes hashes and comparisons reproducible.
 */
export function canonicalJson(value: JsonValue): string {
  // `undefined` can sneak in through optional fields on objects
  // cast at persistence boundaries; treat it as null so the
  // canonical form stays total and deterministic.
  if (
    value === null ||
    value === undefined ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  const keys = Object.keys(value).sort();
  const body = keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key] as JsonValue)}`).join(',');
  return `{${body}}`;
}

/** SHA-256 hex digest of an arbitrary string. */
export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** SHA-256 hex digest of the canonical JSON form of a value. */
export function hashJson(value: JsonValue): string {
  return sha256Hex(canonicalJson(value));
}
