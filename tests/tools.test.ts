import { describe, expect, it } from 'vitest';
import { ToolRegistry } from '../src/tools/tool-registry.js';
import { CalculatorTool, WordCountTool } from '../src/tools/builtin-tools.js';
import { validateSchema } from '../src/tools/tool.js';
import type { Schema } from '../src/tools/tool.js';
import {
  DuplicateToolError,
  ToolExecutionError,
  ToolNotFoundError,
  ToolValidationError,
} from '../src/core/errors.js';
import { SystemClock } from '../src/core/types.js';
import type { ToolContext } from '../src/tools/tool.js';

const context: ToolContext = { clock: new SystemClock() };

describe('ToolRegistry', () => {
  it('registers, looks up and lists tools', () => {
    const registry = new ToolRegistry();
    const calculator = new CalculatorTool();
    registry.register(calculator);
    expect(registry.has('calculator')).toBe(true);
    expect(registry.get('calculator')).toBe(calculator);
    expect(registry.list().map((tool) => tool.name)).toEqual(['calculator']);
  });

  it('rejects duplicate registration', () => {
    const registry = new ToolRegistry();
    registry.register(new CalculatorTool());
    expect(() => registry.register(new CalculatorTool())).toThrow(DuplicateToolError);
  });

  it('throws ToolNotFoundError for unknown tools', () => {
    const registry = new ToolRegistry();
    expect(() => registry.get('missing')).toThrow(ToolNotFoundError);
    expect(() => registry.validate('missing', {})).toThrow(ToolNotFoundError);
  });

  it('validates tool input against the declared schema', () => {
    const registry = new ToolRegistry();
    registry.register(new CalculatorTool());
    const valid = registry.validate('calculator', { operation: 'add', a: 1, b: 2 });
    expect(valid.ok).toBe(true);
    expect(valid.issues).toHaveLength(0);

    const invalid = registry.validate('calculator', { a: 1, b: 2 });
    expect(invalid.ok).toBe(false);
    expect(invalid.issues.join(' ')).toContain('operation');
    expect(invalid.issues.join(' ')).toContain('required');
  });

  it('executes tools through the registry', async () => {
    const registry = new ToolRegistry();
    registry.register(new CalculatorTool());
    const result = await registry.execute('calculator', { operation: 'multiply', a: 6, b: 7 }, context);
    expect(result).toBe(42);
  });

  it('throws ToolValidationError for invalid execution args', async () => {
    const registry = new ToolRegistry();
    registry.register(new CalculatorTool());
    await expect(
      registry.execute('calculator', { operation: 'add', a: 'x', b: 2 }, context),
    ).rejects.toThrow(ToolValidationError);
  });

  it('wraps unexpected tool failures in ToolExecutionError', async () => {
    const registry = new ToolRegistry();
    registry.register(new CalculatorTool());
    await expect(
      registry.execute('calculator', { operation: 'divide', a: 1, b: 0 }, context),
    ).rejects.toThrow(ToolExecutionError);
  });

  it('rejects execution of unknown tools', async () => {
    const registry = new ToolRegistry();
    await expect(registry.execute('missing', {}, context)).rejects.toThrow(ToolNotFoundError);
  });
});

describe('CalculatorTool', () => {
  const tool = new CalculatorTool();

  it('performs arithmetic', async () => {
    expect(await tool.execute({ operation: 'add', a: 2, b: 3 }, context)).toBe(5);
    expect(await tool.execute({ operation: 'subtract', a: 5, b: 2 }, context)).toBe(3);
    expect(await tool.execute({ operation: 'multiply', a: 4, b: 5 }, context)).toBe(20);
    expect(await tool.execute({ operation: 'divide', a: 10, b: 4 }, context)).toBe(2.5);
  });

  it('rejects division by zero', async () => {
    await expect(
      tool.execute({ operation: 'divide', a: 1, b: 0 }, context),
    ).rejects.toThrow(ToolExecutionError);
  });

  it('declares its input schema', () => {
    expect(tool.inputSchema.type).toBe('object');
    expect(tool.inputSchema.required).toContain('operation');
  });
});

describe('WordCountTool', () => {
  const tool = new WordCountTool();

  it('counts words, characters and lines', async () => {
    const result = (await tool.execute({ text: 'hello world\nsecond line' }, context)) as {
      words: number;
      characters: number;
      lines: number;
    };
    expect(result.words).toBe(4);
    expect(result.characters).toBe(23);
    expect(result.lines).toBe(2);
  });

  it('handles empty text', async () => {
    const result = (await tool.execute({ text: '' }, context)) as {
      words: number;
      characters: number;
      lines: number;
    };
    expect(result.words).toBe(0);
    expect(result.characters).toBe(0);
    expect(result.lines).toBe(0);
  });
});

describe('validateSchema', () => {
  it('validates enums', () => {
    const schema: Schema = { type: 'string', enum: ['a', 'b'] };
    expect(validateSchema(schema, 'a').ok).toBe(true);
    const invalid = validateSchema(schema, 'c');
    expect(invalid.ok).toBe(false);
    expect(invalid.issues[0]).toContain('must be one of');
  });

  it('validates nested objects and required properties', () => {
    const schema: Schema = {
      type: 'object',
      properties: {
        user: {
          type: 'object',
          properties: { name: { type: 'string' }, age: { type: 'integer' } },
          required: ['name'],
        },
      },
      required: ['user'],
    };
    expect(validateSchema(schema, { user: { name: 'x', age: 30 } }).ok).toBe(true);
    const invalid = validateSchema(schema, { user: { age: 30.5 } });
    expect(invalid.ok).toBe(false);
    expect(invalid.issues.join(' ')).toContain('user.name');
    expect(invalid.issues.join(' ')).toContain('integer');
  });

  it('validates arrays with item schemas', () => {
    const schema: Schema = { type: 'array', items: { type: 'integer' } };
    expect(validateSchema(schema, [1, 2, 3]).ok).toBe(true);
    const invalid = validateSchema(schema, [1, 'x']);
    expect(invalid.ok).toBe(false);
    expect(invalid.issues[0]).toContain('[1]');
  });
});
