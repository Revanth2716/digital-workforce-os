import type { Clock } from '../core/types.js';
import type { JsonValue } from '../core/json.js';
import { isJsonObject } from '../core/json.js';

/** JSON-schema-inspired declaration of a tool's input contract. */
export type SchemaType = 'string' | 'number' | 'integer' | 'boolean' | 'object' | 'array';

export interface Schema {
  readonly type: SchemaType;
  readonly properties?: Readonly<Record<string, Schema>>;
  readonly required?: readonly string[];
  readonly items?: Schema;
  readonly enum?: readonly (string | number)[];
  readonly description?: string;
}

export interface SchemaValidation {
  readonly ok: boolean;
  readonly issues: readonly string[];
}

function typeName(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function check(schema: Schema, value: unknown, path: string, issues: string[]): void {
  if (schema.enum !== undefined && !schema.enum.includes(value as string | number)) {
    issues.push(`${path}: must be one of [${schema.enum.join(', ')}], got ${JSON.stringify(value)}`);
    return;
  }
  switch (schema.type) {
    case 'string':
      if (typeof value !== 'string') {
        issues.push(`${path}: expected string, got ${typeName(value)}`);
      }
      break;
    case 'number':
      if (typeof value !== 'number' || Number.isNaN(value)) {
        issues.push(`${path}: expected number, got ${typeName(value)}`);
      }
      break;
    case 'integer':
      if (!Number.isInteger(value)) {
        issues.push(`${path}: expected integer, got ${JSON.stringify(value)}`);
      }
      break;
    case 'boolean':
      if (typeof value !== 'boolean') {
        issues.push(`${path}: expected boolean, got ${typeName(value)}`);
      }
      break;
    case 'object': {
      if (!isJsonObject(value)) {
        issues.push(`${path}: expected object, got ${typeName(value)}`);
        break;
      }
      for (const required of schema.required ?? []) {
        if (!(required in value)) {
          issues.push(`${path}.${required}: required property missing`);
        }
      }
      for (const [key, subSchema] of Object.entries(schema.properties ?? {})) {
        const child = value[key];
        if (child !== undefined) {
          check(subSchema, child as JsonValue, `${path}.${key}`, issues);
        }
      }
      break;
    }
    case 'array': {
      if (!Array.isArray(value)) {
        issues.push(`${path}: expected array, got ${typeName(value)}`);
        break;
      }
      if (schema.items !== undefined) {
        value.forEach((item, index) => {
          check(schema.items as Schema, item as JsonValue, `${path}[${index}]`, issues);
        });
      }
      break;
    }
  }
}

/** Validate an unknown value against a schema, collecting all issues. */
export function validateSchema(schema: Schema, value: unknown, path: string = '$'): SchemaValidation {
  const issues: string[] = [];
  check(schema, value, path, issues);
  return { ok: issues.length === 0, issues };
}

/** Injected into every tool invocation. */
export interface ToolContext {
  readonly signal?: AbortSignal;
  readonly clock: Clock;
}

/**
 * Tool abstraction. Tools are pure functions with declared input schemas,
 * registered by name and invoked through the ToolRegistry so that agents
 * never depend on concrete tool implementations.
 */
export interface Tool<Args = JsonValue, Output = JsonValue> {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Schema;
  execute(args: Args, context: ToolContext): Promise<Output>;
}
