import type { JsonValue } from '../core/json.js';

/** Pseudo-random number generator (deterministic streams). */
export type Prng = () => number;

/**
 * A JSON-Schema-lite view (the subset emitted by
 * `z.toJSONSchema` plus common keywords). The generator
 * only reads these keywords; unknown keywords are ignored.
 */
interface JsonSchema {
  readonly type?: string;
  readonly enum?: readonly (string | number)[];
  readonly properties?: Readonly<Record<string, JsonSchema>>;
  readonly required?: readonly string[];
  readonly items?: JsonSchema;
  readonly additionalProperties?: JsonSchema | boolean;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly minItems?: number;
  readonly maxItems?: number;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly anyOf?: readonly JsonSchema[];
}

const VOCABULARY = [
  'structured',
  'deterministic',
  'validated',
  'governed',
  'auditable',
  'reproducible',
  'offline',
  'schema',
  'workflow',
  'evidence',
  'agent',
  'orchestration',
  'planning',
  'verification',
  'pipeline',
  'analysis',
  'objective',
  'outcome',
] as const;

/**
 * Deterministically generate a JSON instance that conforms
 * to the given JSON Schema, driven by `rng`.
 *
 * Used by the offline deterministic LLM provider as a
 * fallback when no scripted response exists for an intent:
 * any schema the system defines can be instantiated
 * offline, which keeps structured generation testable and
 * reproducible without a network or an API key.
 */
export function generateFromJsonSchema(schema: JsonValue, rng: Prng): JsonValue {
  return generate(schema as JsonSchema, rng, 0);
}

function generate(schema: JsonSchema, rng: Prng, depth: number): JsonValue {
  // Defensive depth guard against pathological/recursive schemas.
  if (depth > 8) return null;
  if (schema.enum !== undefined && schema.enum.length > 0) {
    return schema.enum[Math.floor(rng() * schema.enum.length)] as JsonValue;
  }
  if (schema.anyOf !== undefined && schema.anyOf.length > 0) {
    const branch = schema.anyOf[Math.floor(rng() * schema.anyOf.length)] as JsonSchema;
    return generate(branch, rng, depth + 1);
  }
  switch (schema.type) {
    case 'object':
      return generateObject(schema, rng, depth);
    case 'array':
      return generateArray(schema, rng, depth);
    case 'string':
      return generateString(schema, rng);
    case 'integer':
      return generateNumber(schema, rng, true);
    case 'number':
      return generateNumber(schema, rng, false);
    case 'boolean':
      return rng() < 0.5;
    case 'null':
      return null;
    default:
      // No type information (e.g. `z.unknown()`): null is always valid.
      return null;
  }
}

function generateObject(
  schema: JsonSchema,
  rng: Prng,
  depth: number,
): JsonValue {
  const properties = schema.properties ?? {};
  const required = new Set(schema.required ?? []);
  const result: Record<string, JsonValue> = {};
  // Sorted keys keep generation order deterministic for a given rng stream.
  for (const key of Object.keys(properties).sort()) {
    const propertySchema = properties[key] as JsonSchema;
    // Optional properties are included most of the time for realism;
    // required properties always. Skipped optional fields that carry
    // a `.default()` are filled in by the schema parser itself.
    if (!required.has(key) && rng() < 0.25) continue;
    result[key] = generate(propertySchema, rng, depth + 1);
  }
  // Record-like schemas (`z.record`): no declared properties but an
  // `additionalProperties` schema. Emit one deterministic entry.
  if (Object.keys(properties).length === 0 && typeof schema.additionalProperties === 'object') {
    result['value'] = generate(schema.additionalProperties as JsonSchema, rng, depth + 1);
  }
  return result;
}

function generateArray(
  schema: JsonSchema,
  rng: Prng,
  depth: number,
): JsonValue {
  const min = schema.minItems ?? 1;
  const spread = Math.max(1, (schema.maxItems ?? min + 2) - min + 1);
  const length = min + Math.floor(rng() * spread);
  const items: JsonValue[] = [];
  for (let i = 0; i < length; i++) {
    items.push(generate(schema.items ?? {}, rng, depth + 1));
  }
  return items;
}

function generateString(schema: JsonSchema, rng: Prng): string {
  const wordCount = 2 + Math.floor(rng() * 3);
  const words: string[] = [];
  for (let i = 0; i < wordCount; i++) {
    words.push(VOCABULARY[Math.floor(rng() * VOCABULARY.length)] as string);
  }
  let text = words.join(' ');
  const minLength = schema.minLength ?? 0;
  const maxLength = schema.maxLength;
  if (text.length < minLength) {
    text = text.padEnd(minLength, '.');
  }
  if (maxLength !== undefined && text.length > maxLength) {
    text = text.slice(0, maxLength);
  }
  return text;
}

function generateNumber(
  schema: JsonSchema,
  rng: Prng,
  integer: boolean,
): number {
  const min = schema.minimum ?? 0;
  const max = schema.maximum ?? min + 100;
  const value = min + rng() * (max - min);
  return integer ? Math.floor(value) : value;
}
